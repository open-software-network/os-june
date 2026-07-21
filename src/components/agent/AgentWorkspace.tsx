import { listen } from "@tauri-apps/api/event";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconArrowsRepeat } from "central-icons/IconArrowsRepeat";
import { IconBolt } from "central-icons/IconBolt";
import { IconBranchSimple } from "central-icons/IconBranchSimple";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconBubbleWide } from "central-icons/IconBubbleWide";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconExclamationTriangle } from "central-icons/IconExclamationTriangle";
import { IconFinder } from "central-icons/IconFinder";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconFolders } from "central-icons/IconFolders";
import { IconLightBulbSimple } from "central-icons/IconLightBulbSimple";
import { IconConsole } from "central-icons/IconConsole";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconStopCircle } from "central-icons/IconStopCircle";
import { IconToolbox } from "central-icons/IconToolbox";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { createPortal } from "react-dom";
import { IconArrowCornerDownRight } from "central-icons/IconArrowCornerDownRight";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconConsoleSimple } from "central-icons/IconConsoleSimple";
import { IconDeepSearch } from "central-icons/IconDeepSearch";
import { IconCheckCircle2 } from "central-icons/IconCheckCircle2";
import { IconConcise } from "central-icons/IconConcise";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFiles } from "central-icons/IconFiles";
import { IconFileSparkle } from "central-icons/IconFileSparkle";
import { IconFileText } from "central-icons/IconFileText";
import { IconEmail1Sparkle } from "central-icons/IconEmail1Sparkle";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconGauge } from "central-icons/IconGauge";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconHeartBeat } from "central-icons/IconHeartBeat";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconNotes } from "central-icons/IconNotes";
import { IconPageTextSearch } from "central-icons/IconPageTextSearch";
import { IconPencil } from "central-icons/IconPencil";
import { IconPieChart1 } from "central-icons/IconPieChart1";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconShareOs } from "central-icons/IconShareOs";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { IconStop } from "central-icons/IconStop";
import { DotSpinner } from "../DotSpinner";
import {
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { BackButton } from "../ui/BackButton";
import { TierMiniCard } from "../account/FundingNotice";
import type { FundingTier, TextFundingNoticeContext } from "../account/FundingNotice";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CopyStateIcon } from "../ui/CopyStateIcon";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { HoverTip } from "../ui/HoverTip";
import { InlineNotice } from "../ui/InlineNotice";
import { SegmentedControl } from "../ui/SegmentedControl";
import { toast } from "../ui/Toaster";
import { Spinner } from "../ui/Spinner";
import { Switch } from "../ui/Switch";
import {
  assignSessionToProfile,
  listSessionProfiles,
  cancelAgentTask,
  dictationHelperCommand,
  explainAgentApproval,
  finalizeHermesBridgeBranch,
  getAgentTask,
  getHermesBridgeSkill,
  ensureHermesBridgeSession,
  hermesBridgeFilesystemSnapshot,
  hermesBridgeImageDataUrl,
  hermesBridgeMessagingPlatforms,
  hermesBridgeFilePreview,
  hermesBridgeFileText,
  hermesAgentCliAccess,
  hermesBrowserAccess,
  hermesBridgeSkills,
  generateImage,
  localVideoFileSrc,
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
  suggestAgentSessionTitle,
  toggleHermesBridgeSkill,
  toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform,
  videoGenerate,
  videoStatus,
  type AgentTaskDto,
  type AgentTaskStatus,
  type HermesBridgeStatus,
  type HermesFilesystemEntry,
  type HermesFilesystemSnapshot,
  type ImportedHermesFile,
  type HermesMessagingEnvVarInfo,
  type HermesMessagingPlatformInfo,
  type HermesSessionInfo,
  type HermesSessionMessage,
  type HermesSkillDocument,
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
  beginComputerUseRunLease,
  releaseComputerUseRunLease,
  releaseComputerUseRunsForSession,
  stopComputerUseRuns,
} from "../../lib/computer-use-run-leases";
import {
  deleteHermesSession,
  listHermesSessionMessages,
  listHermesSessions,
  normalizeHermesSessionMessagesResponse,
  sessionTimestamp,
  stripScheduledRunPreamble,
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
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_RUN_SETTLED_EVENT,
  AGENT_RUN_STARTED_EVENT,
  AGENT_SESSION_STATUS_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
  dispatchAgentRunSettled,
  dispatchAgentSessionsChanged,
  dispatchAgentSessionStatus,
  registerAgentRunTerminalDispatchGuard,
  type AgentGalleryDetail,
  type AgentRunSettledDetail,
  type AgentRunStartedDetail,
  type AgentRunTerminalDispatch,
  type AgentSessionsChangedDetail,
  type AgentSessionStatusDetail,
  type AgentSessionStatusKind,
} from "../../lib/agent-events";
import {
  agentRunMonitorSnapshot,
  cancelAgentRunMonitoring,
  hasPendingAgentRunTerminalEvidence,
  isAgentRunMonitorGenerationCurrent,
  markAgentRunSucceeded,
  preserveAgentRunTerminalEvidence,
  releaseAgentRunSettlement,
  startAgentRunMonitoring,
  stopAgentRunMonitoring,
  type AgentRunTerminalEvidence,
} from "../../lib/agent-run-monitor";
import {
  HermesGatewayClient,
  HermesGatewayError,
  isSessionBusyError,
  type HermesGatewayEvent,
} from "../../lib/hermes-gateway";
import {
  classifyHermesEvent,
  createHermesMethods,
  hermesModeFor,
  isTerminalHermesEvent,
  isHermesFeatureSupported,
  isSensitiveKey,
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
  isAgentSessionTitleCandidate,
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
import { ShareLinkCopyAction } from "../share/ShareLinkCopyAction";
import { recordPositiveFeedbackSent } from "../../lib/referral-nudge";
import { useScrollFade } from "../../lib/use-scroll-fade";
import { unsupportedEventStore } from "../../lib/hermes-unsupported-events";
import { shouldBlockTextOnFunding, type TextFundingModelContext } from "../../lib/account-gate";
import { pendingActionInstanceId, pendingActionStore } from "../../lib/hermes-pending-actions";
import { hermesActivityStore, type AgentActivityRecord } from "../../lib/hermes-activity-store";
import {
  appendHermesLiveEvent,
  createHermesLiveStream,
  currentHermesApprovalInstanceId,
  hermesLiveEvents,
  recordHermesIdlessTranscriptPersistenceBoundary,
  reconcileHermesInflightSnapshot,
  reconcileHermesLiveStream,
  reconcileHermesLiveStreamAfterRuntimeReplacement,
  type HermesLiveStream,
} from "../../lib/hermes-live-stream";
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
import { MarkdownContent, highlightText, type HighlightCursor } from "./MarkdownContent";
import { SmoothedStreamingMarkdown } from "./SmoothedStreamingMarkdown";
import {
  ComposerModelPicker,
  PrivacyModeBadge,
  UnrestrictedBadge,
  heroPrivacyFootnote,
} from "./composer/ModelPicker";
import {
  PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
  dispatchProviderModelSettingsChanged,
  modelPrivacyBadge,
  modelSupportsImageInput,
  modelSupportsTools,
  type ModelPrivacyBadge,
  type ProviderModelSettingsChangedDetail,
} from "../../lib/model-privacy";
import {
  MODEL_SWITCH_NEXT_MESSAGE_NOTICE,
  MODEL_SWITCH_DEFAULT_ONLY_NOTICE,
} from "../../lib/hermes-model-switch";
import { applySessionModelWhenIdle } from "../../lib/hermes-next-prompt-model";
import {
  holdHermesSessionDispatch,
  reserveHermesSessionDispatch,
  reserveHermesSessionTransportHandoff,
  withHermesSessionDispatchLock,
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
  AUTO_MODEL_ID,
  modelOptions,
  selectedModel as selectedModelOption,
} from "../settings/ModelPickerDialog";
import {
  ModelCommandPalette,
  ModelPickerPopover,
  type ModelPickerFlyout,
} from "../settings/ModelPickerPopover";
import {
  HERMES_SERVER_ERROR_MESSAGE,
  describeHermesError,
  errorCode,
  isHermesServerError,
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
  type SkillSlashResolution,
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
import { FileTypeIcon, fileTypeIconComponent } from "./FileTypeIcon";
import {
  ISSUE_REPORT_ATTACHMENTS_ONLY_DESCRIPTION,
  isReportCategory,
  REPORT_CATEGORIES,
  type ReportCategory,
} from "./composer/reportCategory";
import { ReportDialog, type ReportDialogAttachment } from "./ReportDialog";
import {
  hermesConnectionForMode,
  hermesRuntimeIncarnation,
  type HermesRuntimeIncarnation,
} from "../../lib/hermes-connection";
import {
  forgetSessionMode,
  rememberSessionMode,
  sessionUnrestricted,
} from "../../lib/agent-session-modes";
import { HERMES_TUI_DEBUG_WARNING, hermesTuiDebugAvailable } from "../../lib/hermes-tui-debug";
import {
  AGENT_CLI_ACCESS_ENABLED_MESSAGE,
  hasAgentCliAccessRequest,
  stripAgentCliAccessRequest,
} from "../../lib/agent-cli-access";
import {
  BROWSER_ACCESS_ENABLED_MESSAGE,
  hasBrowserAccessRequest,
  stripBrowserAccessRequest,
} from "../../lib/browser-access";
import {
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
  displayedComposerUserMessageText,
  hasFinalContentBearingAssistantReply,
  isUpstreamProviderFailureText,
  isGeneratedVideoFilename,
  stripRenderedMediaReferences,
  textFromHermesContent,
  textFromHermesTransportContent,
  UPSTREAM_PROVIDER_FAILURE_NOTICE_BODY,
  UPSTREAM_PROVIDER_FAILURE_RETRY_PROMPT,
  USER_ATTACHMENT_PROMPT_MARKER,
  type AgentApprovalChoice,
  type AgentChatPart,
  type AgentChatTurn,
} from "../../lib/agent-chat-runtime";
import { toolActivitySentence } from "../../lib/agent-tool-labels";
import {
  COMPACTED_CONTEXT_SIGNATURE,
  prepareProjectPrompt,
  ProjectContextSignatureStore,
  stripProjectContext,
  type AgentProjectContext,
} from "../../lib/agent-project-context";
import {
  buildAgentChatGallery,
  buildAgentErrorGallery,
  type AgentChatGallerySection,
} from "../../lib/agent-chat-gallery";
import { attachScrollThumbFade } from "../../lib/scroll-thumb-fade";
import {
  upstreamProviderRecoveryIds,
  upstreamProviderRecoveryStore,
} from "../../lib/upstream-provider-recovery";

const BROWSER_APPROVALS_CHANGED_EVENT = "june://browser-approvals-changed";
const POLLED_STATUSES = new Set<AgentTaskStatus>(["queued", "running", "waitingForUser"]);
const AGENT_TITLE_TIMEOUT_MS = 2500;
const AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const AGENT_WORKSPACE_MAX_SESSION_RETRY_DELAY_MS =
  AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS[AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS.length - 1] ??
  2000;
const projectContextSignaturesBySessionId = new ProjectContextSignatureStore();
const QUEUED_STEER_RETRY_DELAY_MS = 300;
const RESTORED_QUEUED_STEER_RECONCILE_DELAY_MS = 1000;
const RESTORED_QUEUED_STEER_BUSY_RECONCILE_DELAY_MS = 3000;
const COMPOSER_TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

// What the user reads instead of the gateway's "session busy" rejection. No
// action in the pill — the composer's send slot already shows stop while
// June works.
const SESSION_BUSY_NOTICE = "June is still working on the previous message.";

// Connection-shaped failures get a "Try again" on the error banner — these are
// all our own strings (hermes-gateway.ts client errors, ensureHermesGateway),
// so the match is stable. Other errors (downloads, renames…) have no single
// retryable action, so they only offer dismiss.
const GATEWAY_CONNECTION_ERROR = /hermes (gateway|bridge)/i;

// A pending request (approval/sudo/secret/clarify) can only be answered by the
// runtime process that asked for it. When that runtime ends, the session's data
// still loads, but the gateway answers "Session not found" on respond — the
// request is now permanently unanswerable. Every respond handler treats this as
// terminal: it retires the dead-end card and shows SESSION_GONE_MESSAGE rather
// than leaking the raw "Hermes API returned 404 ... Session not found" error.
const SESSION_GONE_MESSAGE = "This session has ended, so the request can no longer be answered.";
const SESSION_NOT_AVAILABLE_MESSAGE =
  "This session is no longer available. Open another conversation or start a new one.";

function approvalResponseKey(storedSessionId: string, instanceId: string): string {
  return `${storedSessionId}\u0000${instanceId}`;
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

function isSessionGoneError(message: string): boolean {
  return message.toLowerCase().includes("session not found");
}

// Dev-tools response gallery handle. Registered at module scope so
// __agentGallery() exists from app launch — registering it inside the component
// meant it was undefined unless the Agent view happened to be mounted, which is
// why the command appeared "not to work" from other views. The handle records
// the desired state and broadcasts it; App switches to the Agent view on show,
// and the workspace applies the state on mount or live via the event.
// Dev builds only — the handle never exists in production bundles.
let galleryDesired: "all" | "errors" | false = false;

function setGalleryDesired(show: boolean, errors = false) {
  galleryDesired = show ? (errors ? "errors" : "all") : false;
  window.dispatchEvent(
    new CustomEvent<AgentGalleryDetail>(AGENT_GALLERY_EVENT, {
      detail: { show, errors },
    }),
  );
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__agentGallery = (show: boolean = true) => {
    setGalleryDesired(show);
    return show
      ? "Agent response gallery shown. Run __agentGallery(false) to hide."
      : "Agent response gallery hidden.";
  };
  // Error-focused variant: just the failure sections, plus the chrome-level
  // error surfaces (error banner, composer busy notice) the turn-based
  // gallery can't represent.
  (window as unknown as Record<string, unknown>).__agentErrors = (show: boolean = true) => {
    setGalleryDesired(show, true);
    return show
      ? "Agent error gallery shown. Run __agentErrors(false) to hide."
      : "Agent error gallery hidden.";
  };
}

// Dev-tools composer state driver (window.__composerSteerDemo). Forces the open
// session's composer into its "June is working" branch — stop takes the slot,
// and typing swaps it for the steer-send in place — so that interaction can be
// iterated on without an in-flight turn. Open any real session first (the
// branch needs a non-provisional session id). The steer-send click won't reach
// a running turn in this mode; it's a visual harness only.
// Dev builds only — the handle never ships.
const COMPOSER_STEER_DEMO_EVENT = "june:agent:composer-steer-demo";
let composerSteerDemoDesired = false;

function setComposerSteerDemoDesired(show: boolean) {
  composerSteerDemoDesired = show;
  window.dispatchEvent(
    new CustomEvent<{ show: boolean }>(COMPOSER_STEER_DEMO_EVENT, { detail: { show } }),
  );
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__composerSteerDemo = (show: boolean = true) => {
    setComposerSteerDemoDesired(show);
    return show
      ? "Composer parked in June-is-working state. Type to reveal the steer-send; run __composerSteerDemo(false) to release."
      : "Composer steer demo released.";
  };
}

// Dev-tools file viewer seeder (window.__agentFiles). Imports one sample file
// per preview path — markdown (rendered + source toggle), plain text, JSON,
// CSV, code, an image, and a binary blob for the no-preview fallback — into
// the real Hermes workspace, then opens the viewer panel on them. Going
// through import_hermes_bridge_file_bytes means every preview is fetched back
// through the same Tauri commands and path validation a real agent file uses.
// Dev builds only — like the gallery, the handle never ships.
const AGENT_DEV_FILES_EVENT = "june:agent:dev-files";

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__agentFiles = (show: boolean = true) => {
    window.dispatchEvent(
      new CustomEvent<{ show: boolean }>(AGENT_DEV_FILES_EVENT, {
        detail: { show },
      }),
    );
    return show
      ? "Seeding sample files and opening the viewer (needs an open conversation; repeat runs add numbered copies). Run __agentFiles(false) to clear."
      : "Sample files cleared from the viewer (workspace copies remain).";
  };
}

const SAMPLE_MARKDOWN = `# Quarterly review

A sample document that exercises **bold**, *italic*, ~~strikethrough~~,
\`inline code\`, and [links](https://opensoftware.co).

## Highlights

- Revenue grew 14% quarter over quarter
- Churn fell below 2%
- *Notes* shipped to general availability

## Rollout plan

1. Ship the beta to design partners
2. Collect feedback for two weeks
3. General availability

> Blockquotes hold anything a block can: paragraphs, lists, or code.

### Numbers

| Metric  | Q1   | Q2   |
| ------- | ---- | ---- |
| Revenue | 1.2M | 1.4M |
| Churn   | 2.4% | 1.9% |

---

\`\`\`ts
export function growth(previous: number, current: number) {
  return (current - previous) / previous;
}
\`\`\`
`;

const SAMPLE_JSON = JSON.stringify(
  {
    report: "quarterly-review",
    quarter: "Q2",
    metrics: { revenue: 1_400_000, churn: 0.019 },
    highlights: ["revenue", "churn", "notes-ga"],
  },
  null,
  2,
);

const SAMPLE_CSV = `metric,q1,q2
revenue,1200000,1400000
churn,0.024,0.019
seats,310,355
`;

const SAMPLE_CODE = `import { growth } from "./growth";

const quarters = [1_200_000, 1_400_000];

export function report() {
  return {
    growth: growth(quarters[0], quarters[1]),
    generatedAt: new Date().toISOString(),
  };
}
`;

const SAMPLE_TEXT = `Plain-text sample.

No markdown extension, so the viewer shows this as monospace text
rather than a rendered document. Line breaks and    spacing survive.
`;

function buildSampleArtifactFiles(): { name: string; bytes: Uint8Array }[] {
  const encoder = new TextEncoder();
  // 0xFE/0xFF never appear in UTF-8, so the backend's text preview rejects
  // this and the viewer lands on its no-preview download fallback.
  const binary = new Uint8Array(512).map((_, index) => (index % 2 ? 0xfe : 0xff));
  return [
    { name: "june-sample.md", bytes: encoder.encode(SAMPLE_MARKDOWN) },
    { name: "june-sample.txt", bytes: encoder.encode(SAMPLE_TEXT) },
    { name: "june-sample.json", bytes: encoder.encode(SAMPLE_JSON) },
    { name: "june-sample.csv", bytes: encoder.encode(SAMPLE_CSV) },
    { name: "june-sample.ts", bytes: encoder.encode(SAMPLE_CODE) },
    { name: "june-sample.png", bytes: sampleImageBytes() },
    { name: "june-sample.bin", bytes: binary },
  ];
}

/** Paints a small gradient card on a canvas so the image preview path has a
 * real PNG to chew on, without bundling a fixture. */
function sampleImageDataUrl(label = "june-sample.png", width = 480, height = 320): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#936862");
    gradient.addColorStop(1, "#f4e3d7");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = "rgba(255, 255, 255, 0.92)";
    context.font = "600 28px sans-serif";
    context.fillText(label, 24, Math.round(height / 2) + 8);
  }
  return canvas.toDataURL("image/png");
}

function sampleImageBytes(): Uint8Array {
  const base64 = sampleImageDataUrl().split(",")[1] ?? "";
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

type AgentPanel = "chat" | "skills" | "messaging";

/**
 * The two write-access modes a new session can start the runtime in. The
 * sandbox is a kernel write-jail (reads are unrestricted either way), chosen
 * per new session — switching restarts June's runtime, so the picker only
 * appears in the hero composer.
 */
// The Unrestricted confirm is a speed bump, not a recurring gate: one
// acknowledgment per app session, after which picking it arms directly.
// sessionStorage scopes that to the running app (a relaunch asks again) and
// survives the workspace remounting on view switches.
const UNRESTRICTED_ACK_KEY = "june.agent.unrestrictedAcknowledged";

function unrestrictedAcknowledged(): boolean {
  try {
    return window.sessionStorage.getItem(UNRESTRICTED_ACK_KEY) === "true";
  } catch {
    return false;
  }
}

function rememberUnrestrictedAcknowledged() {
  try {
    window.sessionStorage.setItem(UNRESTRICTED_ACK_KEY, "true");
  } catch {
    // Ignore; worst case the dialog shows again.
  }
}

const SANDBOX_OPTIONS = [
  {
    unrestricted: false,
    icon: <IconShieldCheck size={16} aria-hidden />,
    title: "Sandboxed",
    description: "June can read your files but only change its own workspace.",
  },
  {
    unrestricted: true,
    icon: <IconShieldCrossed size={16} aria-hidden />,
    title: "Unrestricted",
    description: "June can change any file your account can.",
  },
] as const;

type AgentShortcut = {
  key: string;
  icon: ReactNode;
  title: string;
  description: string;
  prompt: string;
  /**
   * "prefill" drops the prompt into the composer for the user to finish; the
   * first `<placeholder>` token arrives as its bare phrase, selected for
   * overtyping — the angle brackets are authoring syntax and never reach the
   * composer. "attach" prefills and
   * opens the file picker. There is deliberately no action that submits on
   * click: every preset lands in the composer first, so the person sees
   * exactly what will run — and approves the spend — before it costs tokens.
   */
  action: "prefill" | "attach";
};

/**
 * Suggestion pool for the new-session hero. Shown HERO_SHORTCUT_COUNT at a
 * time and reshuffled on each visit, so the entry point stays a handful of
 * fresh ideas instead of a wall of ten cards. Pool order matters: the leading
 * window is the curated first-impression mix (a note-native ready-to-send
 * prompt, a placeholder prefill, an attach flow) that shows when the shuffle
 * is identity (e.g. in tests with Math.random mocked to 0). At least one
 * chip in that window should be something only June can do — recapping your
 * own notes — not a generic computer chore.
 *
 * Every suggestion must succeed inside the default write-jail: reads are
 * broad, but writes land only in the agent workspace. Don't add shortcuts
 * that rename, move, or delete the user's files (tidy a folder, free up
 * disk space, dedupe) — the sandbox denies the write mid-task and June's
 * own suggestion reads as broken.
 */
const AGENT_SHORTCUTS: AgentShortcut[] = [
  {
    key: "recap-notes",
    icon: <IconNotes size={18} />,
    title: "Recap my notes",
    description: "What happened, what got decided, what's still open.",
    prompt:
      "Look through my recent meeting notes and give me a quick recap: what happened, what got decided, and any action items still open. Keep it brief.",
    action: "prefill",
  },
  {
    key: "research",
    icon: <IconDeepSearch size={18} />,
    title: "Research a topic",
    description: "Get a short, sourced write-up on anything.",
    prompt:
      "Research <a topic> and write a short summary (a few paragraphs) of what you find, with sources.",
    action: "prefill",
  },
  {
    key: "summarize-file",
    icon: <IconFileSparkle size={18} />,
    title: "Summarize a file",
    description: "Pick a document and get the key points out of it.",
    prompt: "Summarize the key points of the attached file and pull out any action items.",
    action: "attach",
  },
  {
    key: "health-check",
    icon: <IconHeartBeat size={18} />,
    title: "Check my Mac's health",
    description: "Disk, memory, and login items that need attention.",
    prompt:
      "Give my computer a quick health check: free disk space, memory pressure, login items, and anything else worth flagging. Summarize what looks fine and what needs attention.",
    action: "prefill",
  },
  {
    key: "draft-follow-up",
    icon: <IconEmail1Sparkle size={18} />,
    title: "Draft a follow-up",
    description: "Turn your latest meeting note into a follow-up message.",
    prompt:
      "From my most recent meeting note, draft a short follow-up message covering the decisions and next steps.",
    action: "prefill",
  },
  {
    key: "find-file",
    icon: <IconMagnifyingGlass size={18} />,
    title: "Find a file",
    description: "Describe what you remember; June tracks it down.",
    prompt:
      "Find <a file I half-remember> on my computer and tell me where it is. If several candidates match, list them with paths and dates.",
    action: "prefill",
  },
  {
    key: "analyze-spreadsheet",
    icon: <IconPieChart1 size={18} />,
    title: "Analyze a spreadsheet",
    description: "Key figures, trends, and oddities from a CSV or sheet.",
    prompt:
      "Analyze the attached spreadsheet: summarize the key figures and trends, and call out anything that looks off.",
    action: "attach",
  },
  {
    key: "search-notes",
    icon: <IconPageTextSearch size={18} />,
    title: "Search my notes",
    description: "Find where something came up across your meetings.",
    prompt:
      "Search my notes and transcripts for <what I'm trying to remember> and show me where it came up.",
    action: "prefill",
  },
];

/**
 * Hero greetings, one per visit: the heading cycles through this pool each
 * time the hero is entered, tracked in localStorage so the rotation continues
 * across launches. Exported so tests can match "any greeting".
 */
export const HERO_GREETINGS = [
  "What can June do for you?",
  "What should we work on?",
  "Where should June start?",
  "What can June take off your plate?",
] as const;

const HERO_GREETING_INDEX_KEY = "june:agent:hero-greeting";

function advanceHeroGreeting(): string {
  try {
    const index =
      Math.abs(
        Number.parseInt(window.localStorage.getItem(HERO_GREETING_INDEX_KEY) ?? "0", 10) || 0,
      ) % HERO_GREETINGS.length;
    window.localStorage.setItem(
      HERO_GREETING_INDEX_KEY,
      String((index + 1) % HERO_GREETINGS.length),
    );
    return HERO_GREETINGS[index];
  } catch {
    // Storage unavailable: any greeting beats none.
    return HERO_GREETINGS[Math.floor(Math.random() * HERO_GREETINGS.length)];
  }
}

// Three per hand so the row never wraps — a row-count jump mid-rotation would
// shove the footnote around every cycle.
const HERO_SHORTCUT_COUNT = 3;
// Idle cadence for cycling the hand, and how long the cascade-out runs before
// the deck advances (300ms fade + 2 × 90ms stagger, see .agent-hero-chip).
const HERO_ROTATE_MS = 8000;
const HERO_CHIP_SWAP_MS = 500;
const PROVISIONAL_HERMES_SESSION_PREFIX = "pending:new-session:";

function makeProvisionalHermesSessionId() {
  return `${PROVISIONAL_HERMES_SESSION_PREFIX}${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function isProvisionalHermesSessionId(sessionId?: string | null) {
  return Boolean(sessionId && sessionId.startsWith(PROVISIONAL_HERMES_SESSION_PREFIX));
}

// Fisher–Yates with the swap target mirrored (j = i − rand) so a rand() of 0
// is the identity permutation: tests that mock Math.random get the curated
// leading window, real sessions get a fresh shuffle every visit.
function shuffleAgentShortcuts(): AgentShortcut[] {
  const pool = [...AGENT_SHORTCUTS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = i - Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

export const AGENT_SESSION_RENAMED_EVENT = "june:agent:session-renamed";

/** stored session id (not the runtime session id). */
export type AgentSessionRenamedDetail = {
  sessionId: string;
  title: string;
};

export {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_SESSIONS_CHANGED_EVENT,
};

export type { AgentSessionsChangedDetail };

export type AgentNewSessionDetail = {
  prompt?: string;
  /** Opens the direct issue report dialog with the category preselected. No
   * model runs, so there is nothing to charge. */
  category?: ReportCategory;
  /** Seeds the composer with a note chip (and skips auto-submit) so the user
   * lands ready to ask about that note instead of starting an ordinary ask. */
  noteRef?: NoteReferenceInput;
};

/** Frames the user's bug report for June: investigate and write a diagnosis
 * for the team instead of treating it as a normal request for help. */
type PendingIssueReport = {
  category: ReportCategory;
  description: string;
  followUps: string[];
  attachmentNames: string[];
  /** Workspace paths captured at submit, so the files can be uploaded with
   * the report even after the composer clears its attachment chips. */
  attachmentPaths: string[];
  /** Existing sessions can have old assistant replies; only use diagnoses
   * produced after this queued report turn started. */
  diagnosisStartedAt?: string;
};

function hermesServerErrorIssueReport(err: unknown): PendingIssueReport | undefined {
  const rawMessage = messageFromError(err).trim();
  if (!isHermesServerError(rawMessage)) return undefined;
  return {
    category: "bug",
    description: [
      "June hit a Hermes server error while loading this agent session.",
      "",
      "Raw error:",
      rawMessage,
    ].join("\n"),
    followUps: [],
    attachmentNames: [],
    attachmentPaths: [],
  };
}

function reportableAgentErrorOptions(
  err: unknown,
  options: AgentWorkspaceErrorOptions = {},
): AgentWorkspaceErrorOptions {
  const issueReport = hermesServerErrorIssueReport(err);
  if (!issueReport) return options;
  return { ...options, issueReport };
}

type AgentWorkspaceError = {
  message: string;
  /** Null means the error belongs to the no-session workspace surface. */
  sessionId: string | null;
  issueReport?: PendingIssueReport;
};

type AgentWorkspaceErrorOptions = {
  sessionId?: string | null;
  issueReport?: PendingIssueReport;
};

type ImageSafeModeConsentChoice =
  | { action: "keep"; dontAskAgain: boolean }
  | { action: "turnOff"; dontAskAgain: boolean }
  | { action: "dismiss" };

type ImageSafeModeConsentRequest = {
  variant: "slash" | "agent" | "video-slash";
  ownerDispatchReservation?: HermesSessionDispatchReservation;
  resolve: (choice: ImageSafeModeConsentChoice) => void;
};

type ImageSafeModeConsentEventPayload = {
  source?: string;
  prompt?: string;
};

export function agentWorkspaceErrorStateForMessage(
  message: string,
  sessionId: string | null,
  issueReport?: PendingIssueReport,
): AgentWorkspaceError | null {
  if (isSessionGoneError(message)) {
    return {
      message: SESSION_NOT_AVAILABLE_MESSAGE,
      sessionId,
      ...(issueReport ? { issueReport } : {}),
    };
  }
  return { message, sessionId, ...(issueReport ? { issueReport } : {}) };
}

type AgentDeleteSessionDetail = {
  sessionId: string;
};

type AgentArtifact = {
  name: string;
  path: string;
  rootLabel: string;
  size?: number | null;
};

type AgentAttachment = ImportedHermesFile & {
  id: string;
  /** Original `/image` prompt for hidden fast-path context handoff. */
  sourcePrompt?: string;
  /** Ephemeral image data for hidden `/image` fast-path holds. Kept out of
   * visible composer state, artifacts, and traces; cleared with the hold after
   * the next successful prompt submit. */
  attachDataUrl?: string;
  /** Structured attach status (feature 19). Tracks whether this import has been
   * sent to the model via image.attach_bytes: imported (ready) → attached (acked) →
   * or failed. Carries file refs only, never the image bytes. Files stay
   * `imported` (they only ride along as a path in the prompt). */
  attach: HermesAttachmentState;
};

type PersistedImageSlashTurn = {
  id: string;
  sessionId: string;
  prompt: string;
  path: string;
  name: string;
  createdAt: string;
  imageCreatedAt: string;
  contextPending: boolean;
  /** True from just before the paid request starts until import succeeds.
   * `path`/`name` are still empty; the fields below carry the replay shape so
   * an app exit mid-generation can retry the SAME June API request instead of
   * minting a new id and a second charge. */
  pending?: boolean;
  requestId?: string;
  model?: string;
  safeMode?: boolean;
};

type PersistedVideoSlashTurn = {
  id: string;
  sessionId: string;
  prompt: string;
  path: string;
  name: string;
  createdAt: string;
  videoCreatedAt: string;
  pending?: boolean;
  requestId?: string;
  model?: string;
  jobId?: string;
  /** True once the generation completed but its context has not yet ridden a
   * follow-up prompt (the video fold; see storedPendingVideoSlashContexts). */
  contextPending?: boolean;
};

function imageSlashUserTurn(turn: Pick<PersistedImageSlashTurn, "createdAt" | "id" | "prompt">) {
  return {
    id: `${turn.id}:user`,
    role: "user" as const,
    createdAt: turn.createdAt,
    status: "complete" as const,
    parts: [{ type: "text" as const, text: turn.prompt, status: "complete" as const }],
  };
}

function imageSlashAssistantTurn(
  turn: Pick<
    PersistedImageSlashTurn,
    | "id"
    | "imageCreatedAt"
    | "name"
    | "path"
    | "prompt"
    | "createdAt"
    | "pending"
    | "requestId"
    | "model"
    | "safeMode"
  >,
): AgentChatTurn {
  if (turn.pending) {
    // The app exited while this paid generation was in flight. Restore it as
    // a retryable error carrying the pinned request shape - Try again replays
    // the SAME June API request id, so a settled-but-unseen result is
    // deduplicated server-side instead of billed twice.
    return {
      id: `${turn.id}:assistant`,
      role: "assistant",
      createdAt: turn.imageCreatedAt,
      status: "complete",
      parts: [
        {
          type: "image",
          status: "error",
          prompt: turn.prompt,
          requestId: turn.requestId,
          model: turn.model,
          safeMode: turn.safeMode,
          userCreatedAt: turn.createdAt,
          imageCreatedAt: turn.imageCreatedAt,
          error: "Generation was interrupted. Try again to resume.",
        },
      ],
    };
  }
  return {
    id: `${turn.id}:assistant`,
    role: "assistant",
    createdAt: turn.imageCreatedAt,
    status: "complete",
    parts: [
      {
        type: "image",
        status: "complete",
        prompt: turn.prompt,
        path: turn.path,
        name: turn.name,
      },
    ],
  };
}

function runningImageSlashTurns(input: {
  id: string;
  prompt: string;
  requestId: string;
  createdAt: string;
  imageCreatedAt: string;
  model?: string;
  safeMode?: boolean;
}): AgentChatTurn[] {
  return [
    imageSlashUserTurn(input),
    {
      id: `${input.id}:assistant`,
      role: "assistant",
      createdAt: input.imageCreatedAt,
      status: "running",
      parts: [
        {
          type: "image",
          status: "running",
          prompt: input.prompt,
          requestId: input.requestId,
          model: input.model,
          safeMode: input.safeMode,
          userCreatedAt: input.createdAt,
          imageCreatedAt: input.imageCreatedAt,
        },
      ],
    },
  ];
}

function videoSlashUserTurn(turn: Pick<PersistedVideoSlashTurn, "createdAt" | "id" | "prompt">) {
  return {
    id: `${turn.id}:user`,
    role: "user" as const,
    createdAt: turn.createdAt,
    status: "complete" as const,
    parts: [{ type: "text" as const, text: turn.prompt, status: "complete" as const }],
  };
}

function videoSlashAssistantTurn(
  turn: Pick<
    PersistedVideoSlashTurn,
    | "id"
    | "videoCreatedAt"
    | "name"
    | "path"
    | "prompt"
    | "createdAt"
    | "pending"
    | "requestId"
    | "model"
    | "jobId"
  >,
): AgentChatTurn {
  if (turn.pending) {
    return {
      id: `${turn.id}:assistant`,
      role: "assistant",
      createdAt: turn.videoCreatedAt,
      status: turn.jobId ? "running" : "complete",
      parts: [
        {
          type: "video",
          status: turn.jobId ? "running" : "error",
          prompt: turn.prompt,
          requestId: turn.requestId,
          model: turn.model,
          jobId: turn.jobId,
          userCreatedAt: turn.createdAt,
          videoCreatedAt: turn.videoCreatedAt,
          error: turn.jobId ? undefined : "Generation was interrupted. Try again to resume.",
        },
      ],
    };
  }
  return {
    id: `${turn.id}:assistant`,
    role: "assistant",
    createdAt: turn.videoCreatedAt,
    status: "complete",
    parts: [
      {
        type: "video",
        status: "complete",
        prompt: turn.prompt,
        path: turn.path,
        name: turn.name,
        model: turn.model,
      },
    ],
  };
}

function runningVideoSlashTurns(input: {
  id: string;
  prompt: string;
  requestId: string;
  createdAt: string;
  videoCreatedAt: string;
  model?: string;
}): AgentChatTurn[] {
  return [
    videoSlashUserTurn(input),
    {
      id: `${input.id}:assistant`,
      role: "assistant",
      createdAt: input.videoCreatedAt,
      status: "running",
      parts: [
        {
          type: "video",
          status: "running",
          prompt: input.prompt,
          requestId: input.requestId,
          model: input.model,
          userCreatedAt: input.createdAt,
          videoCreatedAt: input.videoCreatedAt,
        },
      ],
    },
  ];
}

function imageSlashTurnsBySessionFromStored(): Record<string, AgentChatTurn[]> {
  const turns = storedImageSlashTurns();
  return Object.fromEntries(
    Object.entries(turns).map(([sessionId, sessionTurns]) => [
      sessionId,
      sessionTurns.flatMap((turn) => [imageSlashUserTurn(turn), imageSlashAssistantTurn(turn)]),
    ]),
  );
}

function videoSlashTurnsBySessionFromStored(): Record<string, AgentChatTurn[]> {
  const turns = storedVideoSlashTurns();
  return Object.fromEntries(
    Object.entries(turns).map(([sessionId, sessionTurns]) => [
      sessionId,
      sessionTurns.flatMap((turn) => [videoSlashUserTurn(turn), videoSlashAssistantTurn(turn)]),
    ]),
  );
}

function storedPendingImageSlashAttachments(sessionId: string): AgentAttachment[] {
  return (storedImageSlashTurns()[sessionId] ?? [])
    .filter((turn) => turn.contextPending)
    .map((turn) => {
      const file = importedFileFromImageSlashTurn(turn);
      return {
        ...file,
        id: `held-image:${turn.id}`,
        sourcePrompt: turn.prompt,
        attach: attachmentStateFrom(file, sessionId),
      };
    });
}

function importedFileFromImageSlashTurn(turn: PersistedImageSlashTurn): ImportedHermesFile {
  return {
    name: turn.name,
    path: turn.path,
    rootLabel: "Workspace",
    size: 0,
    previewDataUrl: null,
  };
}

function storedImageSlashTurns(): Record<string, PersistedImageSlashTurn[]> {
  try {
    const raw = window.localStorage.getItem(IMAGE_SLASH_TURNS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([sessionId, value]) => [
          sessionId,
          Array.isArray(value)
            ? value
                .map((item) => persistedImageSlashTurn(sessionId, item))
                .filter((item): item is PersistedImageSlashTurn => item !== undefined)
            : [],
        ])
        .filter(([, turns]) => turns.length > 0),
    );
  } catch {
    return {};
  }
}

function persistedImageSlashTurn(
  sessionId: string,
  value: unknown,
): PersistedImageSlashTurn | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PersistedImageSlashTurn>;
  // A pending entry (paid request in flight when the app exited) has no
  // path/name yet; its replay request id is what makes it worth restoring.
  const pending =
    candidate.pending === true &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.trim() !== "";
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.prompt !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.imageCreatedAt !== "string" ||
    !candidate.id.trim() ||
    !candidate.prompt.trim() ||
    (!pending && !candidate.path.trim()) ||
    (!pending && !candidate.name.trim()) ||
    Number.isNaN(Date.parse(candidate.createdAt)) ||
    Number.isNaN(Date.parse(candidate.imageCreatedAt))
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    sessionId,
    prompt: candidate.prompt,
    path: candidate.path,
    name: candidate.name,
    createdAt: candidate.createdAt,
    imageCreatedAt: candidate.imageCreatedAt,
    // A pending turn has no image to attach on the follow-up.
    contextPending: pending ? false : candidate.contextPending !== false,
    ...(pending
      ? {
          pending: true,
          requestId: candidate.requestId,
          model: typeof candidate.model === "string" ? candidate.model : undefined,
          safeMode: typeof candidate.safeMode === "boolean" ? candidate.safeMode : undefined,
        }
      : {}),
  };
}

function writeStoredImageSlashTurns(turns: Record<string, PersistedImageSlashTurn[]>) {
  try {
    const entries = Object.entries(turns)
      .map(([sessionId, sessionTurns]) => [
        sessionId,
        sessionTurns
          .slice()
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(-50),
      ])
      .filter(([, sessionTurns]) => (sessionTurns as PersistedImageSlashTurn[]).length > 0);
    if (!entries.length) {
      window.localStorage.removeItem(IMAGE_SLASH_TURNS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      IMAGE_SLASH_TURNS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Best-effort restore only; the live in-memory turns still render.
  }
}

function upsertStoredImageSlashTurn(turn: PersistedImageSlashTurn) {
  const turns = storedImageSlashTurns();
  const sessionTurns = turns[turn.sessionId] ?? [];
  turns[turn.sessionId] = [...sessionTurns.filter((item) => item.id !== turn.id), turn];
  writeStoredImageSlashTurns(turns);
}

function markStoredImageSlashTurnsAttached(sessionId: string, paths: string[]) {
  if (!paths.length) return;
  const pathSet = new Set(paths);
  const turns = storedImageSlashTurns();
  const sessionTurns = turns[sessionId] ?? [];
  if (!sessionTurns.length) return;
  turns[sessionId] = sessionTurns.map((turn) =>
    pathSet.has(turn.path) ? { ...turn, contextPending: false } : turn,
  );
  writeStoredImageSlashTurns(turns);
}

function removeStoredImageSlashSession(sessionId: string) {
  const turns = storedImageSlashTurns();
  if (!turns[sessionId]) return;
  delete turns[sessionId];
  writeStoredImageSlashTurns(turns);
}

function storedVideoSlashTurns(): Record<string, PersistedVideoSlashTurn[]> {
  try {
    const raw = window.localStorage.getItem(VIDEO_SLASH_TURNS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([sessionId, value]) => [
          sessionId,
          Array.isArray(value)
            ? value
                .map((item) => persistedVideoSlashTurn(sessionId, item))
                .filter((item): item is PersistedVideoSlashTurn => item !== undefined)
            : [],
        ])
        .filter(([, turns]) => turns.length > 0),
    );
  } catch {
    return {};
  }
}

function persistedVideoSlashTurn(
  sessionId: string,
  value: unknown,
): PersistedVideoSlashTurn | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PersistedVideoSlashTurn>;
  const pending =
    candidate.pending === true &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.trim() !== "";
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.prompt !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.videoCreatedAt !== "string" ||
    !candidate.id.trim() ||
    !candidate.prompt.trim() ||
    (!pending && !candidate.path.trim()) ||
    Number.isNaN(Date.parse(candidate.createdAt)) ||
    Number.isNaN(Date.parse(candidate.videoCreatedAt))
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    sessionId,
    prompt: candidate.prompt,
    path: candidate.path,
    name: candidate.name,
    createdAt: candidate.createdAt,
    videoCreatedAt: candidate.videoCreatedAt,
    // A pending turn has no completed video to describe on the follow-up.
    // Defaults true for completed turns stored before this field existed, so
    // sessions with an already-generated video get the fold on their next
    // message too.
    contextPending: pending ? false : candidate.contextPending !== false,
    ...(pending
      ? {
          pending: true,
          requestId: candidate.requestId,
          model: typeof candidate.model === "string" ? candidate.model : undefined,
          jobId: typeof candidate.jobId === "string" ? candidate.jobId : undefined,
        }
      : {
          model: typeof candidate.model === "string" ? candidate.model : undefined,
        }),
  };
}

function writeStoredVideoSlashTurns(turns: Record<string, PersistedVideoSlashTurn[]>) {
  try {
    const entries = Object.entries(turns)
      .map(([sessionId, sessionTurns]) => [
        sessionId,
        sessionTurns
          .slice()
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(-50),
      ])
      .filter(([, sessionTurns]) => (sessionTurns as PersistedVideoSlashTurn[]).length > 0);
    if (!entries.length) {
      window.localStorage.removeItem(VIDEO_SLASH_TURNS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      VIDEO_SLASH_TURNS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Best-effort restore only; the live in-memory turns still render.
  }
}

function upsertStoredVideoSlashTurn(turn: PersistedVideoSlashTurn) {
  const turns = storedVideoSlashTurns();
  const sessionTurns = turns[turn.sessionId] ?? [];
  turns[turn.sessionId] = [...sessionTurns.filter((item) => item.id !== turn.id), turn];
  writeStoredVideoSlashTurns(turns);
}

function removeStoredVideoSlashTurn(id: string) {
  const turns = storedVideoSlashTurns();
  let changed = false;
  for (const [sessionId, sessionTurns] of Object.entries(turns)) {
    const nextTurns = sessionTurns.filter((item) => item.id !== id);
    if (nextTurns.length === sessionTurns.length) continue;
    changed = true;
    if (nextTurns.length) {
      turns[sessionId] = nextTurns;
    } else {
      delete turns[sessionId];
    }
  }
  if (changed) writeStoredVideoSlashTurns(turns);
}

function removeStoredVideoSlashSession(sessionId: string) {
  const turns = storedVideoSlashTurns();
  if (!turns[sessionId]) return;
  delete turns[sessionId];
  writeStoredVideoSlashTurns(turns);
}

/** Completed `/video` fast-path turns whose context has not yet ridden a
 * follow-up prompt. The fast path never invokes the model (skipPrompt), so
 * without this fold a follow-up reads as the first message of the conversation
 * and the model does not know a video was ever generated. Mirrors the JUN-171
 * held-image fold, but as text: no model takes an mp4 as input, so the context
 * is described rather than attached. */
function storedPendingVideoSlashContexts(sessionId: string): PersistedVideoSlashTurn[] {
  return (storedVideoSlashTurns()[sessionId] ?? []).filter(
    (turn) => turn.contextPending && !turn.pending && turn.path.trim() !== "",
  );
}

function markStoredVideoSlashContextsSent(sessionId: string, ids: string[]) {
  if (!ids.length) return;
  const idSet = new Set(ids);
  const turns = storedVideoSlashTurns();
  const sessionTurns = turns[sessionId] ?? [];
  if (!sessionTurns.length) return;
  turns[sessionId] = sessionTurns.map((turn) =>
    idSet.has(turn.id) ? { ...turn, contextPending: false } : turn,
  );
  writeStoredVideoSlashTurns(turns);
}

/** Appends the pending `/video` context under the `--- Attached Context ---`
 * marker, which every user-bubble render path already strips - the model sees
 * it, the user never does (same convention as unsupportedImageInputPrompt). */
function withVideoFastPathContext(content: string, turns: PersistedVideoSlashTurn[]): string {
  if (!turns.length) return content;
  return [
    content,
    "",
    "--- Attached Context ---",
    "Earlier in this session the user generated video(s) with the /video command. Those turns ran outside this transcript; the videos already play inline for the user:",
    ...turns.map(
      (turn) =>
        `- prompt: "${turn.prompt}" -> ${turn.name || "video"}${
          turn.model ? ` (model: ${turn.model})` : ""
        }, saved at ${turn.path}`,
    ),
    "Generated videos cannot be edited in place. If the user asks to change, extend, or redo a video, call the june_video generate_video tool with a revised full prompt (or animate_image to animate a source image).",
  ].join("\n");
}

function filenameFromWorkspacePath(path: string, fallback: string) {
  const name = path.split(/[\\/]/).pop()?.trim();
  return name || fallback;
}

function uniqueAttachmentsByWorkspacePath(attachments: AgentAttachment[]) {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = attachment.attach.workspacePath ?? attachment.path ?? attachment.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function promptSubmitContentWithFastPathImageContext(
  content: string,
  heldImages: AgentAttachment[],
) {
  const prompts = [
    ...new Set(
      heldImages
        .map((attachment) => attachment.sourcePrompt?.trim())
        .filter((prompt): prompt is string => Boolean(prompt)),
    ),
  ];
  if (!prompts.length) return content;
  // Tuck the prompt(s) under the "--- Attached Context ---" marker (same
  // convention as unsupportedImageInputPrompt) so the model reads it but
  // displayContentForHermesMessage strips it on reload — otherwise the
  // "Previous /image request: ..." line shows as user-authored text.
  const contextLines =
    prompts.length === 1
      ? [`Previous /image request: ${prompts[0]}`]
      : ["Previous /image requests:", ...prompts.map((prompt, index) => `${index + 1}. ${prompt}`)];
  return [content, "", "--- Attached Context ---", ...contextLines].join("\n");
}

/** Thrown when a structured image attach fails so the prompt is NOT sent with a
 * missing image (feature 19). Carries the attachments with their failed status
 * so submit()'s catch can restore the chips showing what didn't go through. */
class AttachBlockedError extends Error {
  constructor(
    message: string,
    readonly attachments: AgentAttachment[],
  ) {
    super(message);
    this.name = "AttachBlockedError";
  }
}

class AgentRunSupersededError extends Error {
  constructor() {
    super("June started another run before this message was accepted.");
    this.name = "AgentRunSupersededError";
  }
}

type PreparedComposerSubmission = {
  displayContent: string;
  runtimeContent: string;
  titleContent: string;
  typedMessage: string;
};

type CapturedSessionModelTarget = {
  /** Null means this Send starts a new session. */
  targetStoredSessionId: string | null;
  existingHermesModelId?: string;
  selection: SessionModelSelection;
  hermesModelId: string;
  revision?: number;
  shouldApply: boolean;
  globalIntentRevision: number;
};

function sameSessionModelSelection(
  left: SessionModelSelection,
  right: SessionModelSelection,
): boolean {
  return left.modelId === right.modelId && left.costQuality === right.costQuality;
}

type QueuedAttachmentFollowUp = {
  id: string;
  prepared: PreparedComposerSubmission;
  attachments: AgentAttachment[];
  modelTarget: CapturedSessionModelTarget;
  dispatchReservation?: HermesSessionDispatchReservation;
  dispatchOrder?: number;
  status: "queued" | "sending" | "failed";
  error?: string;
};

type QueuedAttachmentFollowUpDeliveryRecord = {
  queueKey: string;
  itemId: string;
  status: "sending" | "sent" | "failed";
  attachments?: AgentAttachment[];
  error?: string;
};

type CompletedAgentRunContinuationRecord = {
  generation: number | undefined;
  source: symbol | undefined;
  pendingSource?: symbol;
  pendingGeneration?: number;
  phase: "pending" | "delivering";
  owner?: symbol;
  timer?: number;
  prepared: boolean;
  steerFollowUpIds: string[];
  deliverySettled?: Promise<void>;
  resolveDeliverySettled?: () => void;
};

type PendingSteer = {
  text: string;
  accepted: boolean;
  toolDrained: boolean;
  modelTarget: CapturedSessionModelTarget;
  dispatchReservation?: HermesSessionDispatchReservation;
  dispatchOrder: number;
};

type PendingAttachmentPreparation = {
  dispatchOrder: number;
  dispatchReservation?: HermesSessionDispatchReservation;
  cancelled: boolean;
};

const UP_NEXT_DEMO_IMAGE_PREVIEW =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='44' height='44'%3E%3Crect width='44' height='44' rx='8' fill='%23d8d5ee'/%3E%3Ccircle cx='17' cy='17' r='7' fill='%237a70ba'/%3E%3C/svg%3E";

function buildUpNextDemoImageAttachment(id: string, name: string): AgentAttachment {
  return {
    id,
    name,
    path: `uploads/${name}`,
    rootLabel: "Hermes workspace",
    size: 24_576,
    previewDataUrl: UP_NEXT_DEMO_IMAGE_PREVIEW,
    attach: {
      localId: id,
      kind: "image",
      displayName: name,
      workspacePath: `uploads/${name}`,
      status: "imported",
    },
  };
}

function buildUpNextDemoFileAttachment(id: string, name: string): AgentAttachment {
  return {
    id,
    name,
    path: `uploads/${name}`,
    rootLabel: "Hermes workspace",
    size: 182_400,
    attach: {
      localId: id,
      kind: "file",
      displayName: name,
      workspacePath: `uploads/${name}`,
      status: "imported",
    },
  };
}

function buildUpNextDemoPrepared(text: string): PreparedComposerSubmission {
  return { displayContent: text, runtimeContent: text, titleContent: text, typedMessage: text };
}

const UP_NEXT_DEMO_MODEL_TARGET: CapturedSessionModelTarget = {
  targetStoredSessionId: null,
  selection: { modelId: AUTO_MODEL_ID, costQuality: 100 },
  hermesModelId: hermesModelIdForSelection({ modelId: AUTO_MODEL_ID, costQuality: 100 }),
  shouldApply: false,
  globalIntentRevision: 0,
};

// Every follow-up shape the queue can hold: a single-image message and a
// multi-attachment message led by a file, so the tile well, the thumbnail,
// and the overflow count all render at once.
function buildUpNextDemoFollowUps(): QueuedAttachmentFollowUp[] {
  return [
    {
      id: "attachment-follow-up-demo",
      prepared: buildUpNextDemoPrepared("Review this attachment next"),
      attachments: [buildUpNextDemoImageAttachment("attachment-demo-image", "reference.png")],
      modelTarget: UP_NEXT_DEMO_MODEL_TARGET,
      status: "queued",
    },
    {
      id: "attachment-follow-up-demo-multi",
      prepared: buildUpNextDemoPrepared("Fold these findings into the report"),
      attachments: [
        buildUpNextDemoFileAttachment("attachment-demo-file", "usability-findings.pdf"),
        buildUpNextDemoImageAttachment("attachment-demo-image-2", "session-notes.png"),
        buildUpNextDemoImageAttachment("attachment-demo-image-3", "heatmap.png"),
      ],
      modelTarget: UP_NEXT_DEMO_MODEL_TARGET,
      status: "queued",
    },
  ];
}

type ComposerInputSizeWarning = {
  inputSignature: string;
  signature: string;
  estimatedTokens: number;
  contextLimit: number;
  modelName: string;
  switchModel?: VeniceModelDto;
};

type ComposerDraftSnapshot = {
  text: string;
  category: ReportCategory | null;
  attachments: AgentAttachment[];
};

/** The right-hand file viewer: a list of every file surfaced in the
 * conversation, or one file opened for reading. */
type AgentArtifactPanelState = { view: "list" } | { view: "file"; artifact: AgentArtifact };

type TauriFileDropPayload = {
  paths?: string[];
};

type FileBytesImportOptions = {
  tooLargeMessage: string;
  readErrorMessage: (file: File) => string;
  maxFiles?: number;
};

type HermesRuntimeSessionResponse = {
  inflight?: {
    assistant?: string;
    streaming?: boolean;
    user?: string;
  } | null;
  messages?: unknown[];
  pending_message_complete?: {
    /** Zero-based ordinal among content-bearing assistant rows in `messages`.
     * The patched runtime supplies this only when that row's complete event is
     * still pending the same atomic transport-delivery decision as resume. */
    assistant_ordinal?: number;
  };
  retired_approval_request_ids?: string[];
  running?: boolean;
  session_id?: string;
  stored_session_id?: string;
};

/** Where the session was opened from — rendered as the leading crumbs in the
 * sticky session bar ("Projects / June" or "Agents") with a back arrow. */
export type AgentWorkspaceOrigin = {
  backLabel: string;
  onBack: () => void;
  crumbs: { label: string; icon?: ReactNode; onClick: () => void }[];
};

type AgentWorkspaceProps = {
  initialSession?: HermesSessionInfo;
  initialSessionId?: string;
  origin?: AgentWorkspaceOrigin;
  onSessionSelected?: (session: HermesSessionInfo | undefined) => void;
  onTopUp?: () => void | Promise<void>;
  topUpLabel?: string;
  /** Whether the active session is filed in a project — drives the session
   * bar menu's project item label (App owns the folder state). */
  sessionInProject?: boolean;
  /** Current project metadata for hidden prompt context injection. */
  projectContext?: AgentProjectContext;
  /** Resolves the project a specific stored session is filed in. Background
   * deliveries (queued steers/attachments) target sessions other than the
   * active one; injecting the ambient `projectContext` there would leak the
   * open project's instructions into another session's run. */
  resolveSessionProjectContext?: (storedSessionId: string) => AgentProjectContext | undefined;
  /** Opens the change-project dialog (which also owns removal) for the given
   * stored session id. */
  onMoveSessionToProject?: (sessionId: string) => void;
  creditActionsDisabledReason?: string;
  /** App owns the account and billing action; the composer owns the active
   * session model and picker. This typed boundary joins them without guessing
   * from the app-wide setting. */
  renderFundingNotice?: (context: TextFundingNoticeContext) => ReactNode;
  /** The user's current plan; the in-transcript stopped-turn credits card
   * leads with its tier card. */
  fundingTier?: FundingTier;
  testOnlySlashCommandEntriesRef?: {
    current: {
      runImageSlashCommand: (argument: string, commandText: string) => Promise<void>;
      runVideoSlashCommand: (argument: string, commandText: string) => Promise<void>;
    } | null;
  };
};

// Mid-run continuity across remounts. While June is working, a session has
// state that exists nowhere outside this component: the optimistic list entry
// (title + preview), the just-sent user bubble Hermes hasn't persisted yet,
// the stored→runtime session mapping, the buffered live events, the title
// override, and any queued issue report draft, the review-ready report waiting
// for the user to send, and the delayed diagnosis refresh that makes the final
// June answer available to the report payload. Working/waiting/tool-call
// display state lives in the module-global activity store, which survives this
// workspace unmount.
// Navigating away (e.g. to Settings) unmounts the workspace; without this
// snapshot the remount restores only the selected id from localStorage, and a
// session whose first turn hasn't persisted renders as an empty "Untitled
// session" that nothing ever polls back to life. Captured on unmount for
// sessions with activity-store work or local pending/report state, hydrated by
// the next mount's state initializers so the working poll picks the run
// straight back up.
type AgentSessionContinuity = {
  sessionItems: HermesSessionInfo[];
  pendingMessages: Record<string, HermesSessionMessage[]>;
  runtimeSessionIds: Record<string, string>;
  liveEvents: Record<string, HermesLiveStream>;
  runStartRevisions: Record<string, number>;
  runAuthorityProofs: Record<string, AgentRunAuthorityProof>;
  runCompletionSources: Record<string, symbol>;
  terminalFingerprints: Record<string, string[]>;
  titleOverrides: Record<string, string>;
  titleSources: Record<string, AgentSessionTitleSource>;
  pendingIssueReports: Record<string, PendingIssueReport>;
  reviewableIssueReports: Record<string, PendingIssueReport>;
  diagnosisRefreshIssueReportSessionIds: string[];
  submittingIssueReportSessionIds: string[];
  queuedAttachmentFollowUps: Record<string, QueuedAttachmentFollowUp[]>;
};

type AgentRunPersistenceBoundary = {
  persistedUserIds: Set<string>;
  persistedUserCount: number;
  historyWasHydrated: boolean;
  submittedAtMs: number;
  promptDispatchedAtMs?: number;
};

type AgentRunAuthorityProof = {
  persistenceBoundary: AgentRunPersistenceBoundary;
  runtimeIncarnation?: HermesRuntimeIncarnation;
  submittedUserMessage: HermesSessionMessage;
};

type AgentRunTranscriptPersistenceProof = {
  authorityProof: AgentRunAuthorityProof;
  runStartRevision: number;
};

type PendingAgentRunTerminalEvidence = {
  authorityProof: AgentRunAuthorityProof;
  completionSource: symbol;
  evidence: AgentRunTerminalEvidence;
};

type WorkingReconcileMiss = {
  completionSource: symbol | undefined;
  count: number;
};

type AcceptedAgentRunListener = {
  confirmMonitorStarted: (generation: number) => void;
};

type AgentRunGatewayEventRoute = {
  completionSource: symbol;
  handleEvent: (event: HermesGatewayEvent) => void;
  listenerEpoch: symbol;
  mountEpoch: symbol | undefined;
  retireApprovalsAtPhysicalClose: () => void;
  semanticConsumerActive: boolean;
};

type AgentRunGatewayEventHandoff = {
  completionSource: symbol;
  events: HermesGatewayEvent[];
};

type AgentRunGatewayPhysicalDetach = {
  completionSource: symbol;
  detached: Promise<void>;
  mountEpoch: symbol | undefined;
  resolve: () => void;
  storedSessionId: string;
};

type BufferedAgentRunTerminal = {
  candidateRunStarted: boolean;
  event: HermesGatewayEvent;
};

type PendingAgentRunAcceptance = {
  authorityProof: AgentRunAuthorityProof;
  bufferedApprovals: HermesGatewayEvent[];
  bufferedTerminals: BufferedAgentRunTerminal[];
  candidateRunStarted: boolean;
  candidateRunStartRevision: number;
  completionSource: symbol;
  existingCompletionSource: symbol | undefined;
  previousAuthorityProof: AgentRunAuthorityProof | undefined;
  previousPendingTerminalEvidence: PendingAgentRunTerminalEvidence | undefined;
  previousReconcileMiss: WorkingReconcileMiss | undefined;
  previousRunStartRevision: number | undefined;
  predecessorMonitorOwner: AgentRunMonitorOwner | undefined;
  predecessorMonitorWasActive: boolean;
  predecessorRunMonitorGeneration: number | undefined;
  deferredPredecessorMonitorTerminal?: AgentRunMonitorTerminalRecord;
  onSuperseded?: () => void;
  acceptWithCurrentListener?: () => AcceptedAgentRunListener | undefined;
  rejectWithCurrentListener?: () => boolean;
  restoreBusyWithCurrentListener?: () => boolean;
};

type AgentRunMonitorOwner = {
  authorityProof: AgentRunAuthorityProof;
  generation: number;
};

type AgentRunMonitorTerminalRecord =
  | { kind: "status"; detail: AgentSessionStatusDetail }
  | { kind: "settled"; detail: AgentRunSettledDetail };

type AgentSessionTitleSource = "prompt" | "exchange" | "manual" | "rejected" | "rejected-final";

type IssueReportDeliveryResult = { sent: true } | { sent: false; errorMessage: string };

type IssueReportDeliverySettledDetail = {
  storedSessionId: string;
  report: PendingIssueReport;
  result: IssueReportDeliveryResult;
};

type IssueReportPromotedDetail = {
  storedSessionId: string;
  report: PendingIssueReport;
  queueDiagnosisRefresh: boolean;
};

type IssueReportFollowUpSubmitFailedDetail = {
  storedSessionId: string;
  queuedReport: PendingIssueReport;
  restoreReport?: PendingIssueReport;
};

type IssueReportUiTransition =
  | { kind: "delivery-settled"; detail: IssueReportDeliverySettledDetail }
  | { kind: "follow-up-submit-failed"; detail: IssueReportFollowUpSubmitFailedDetail };

type IssueReportDiagnosisRefreshRecord = {
  due: boolean;
  executionGeneration: number;
  executingGeneration?: number;
  executor?: (proof?: AgentRunTranscriptPersistenceProof) => Promise<void>;
  owner?: symbol;
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
  timer: number;
  transcriptPersistenceProof?: AgentRunTranscriptPersistenceProof;
};

let sessionContinuity: AgentSessionContinuity | null = null;
// A prompt can remain inside prompt.submit while navigation remounts the
// Workspace. Keep replay-ambiguous terminal evidence at app lifetime so the
// replacement Workspace cannot infer success from partial prose plus idle,
// and so the original async acknowledgement can hand the same evidence to the
// app-lifetime run monitor.
const pendingAgentRunTerminalEvidenceRegistry = new Map<string, PendingAgentRunTerminalEvidence>();
const pendingAgentRunAcceptanceRegistry = new Map<string, PendingAgentRunAcceptance>();
const agentRunMonitorOwnerRegistry = new Map<string, AgentRunMonitorOwner>();
const agentRunGatewayEventRouteRegistry = new Map<string, AgentRunGatewayEventRoute>();
const agentRunGatewayEventHandoffRegistry = new Map<string, AgentRunGatewayEventHandoff>();
const agentRunGatewayPhysicalDetachRegistry = new Map<string, AgentRunGatewayPhysicalDetach>();
const latestAgentRunGenerationRegistry = new Map<string, number>();
const latestAgentRunGenerationOrder: string[] = [];
const supersededAgentRunGenerationRegistry = new Map<string, number>();
const MAX_AGENT_RUN_GENERATION_TOMBSTONES = 100;
// Issue-report prompts can remain inside prompt.submit while navigation
// replaces the Workspace. Keep the tentative report at app lifetime so the
// acknowledgement and terminal event still meet the same object. Acceptance
// is tracked separately: an older terminal may observe the tentative report,
// but cannot promote it before this prompt is acknowledged as current.
const pendingIssueReportRegistry = new Map<string, PendingIssueReport>();
const acceptedPendingIssueReportRegistry = new Map<string, PendingIssueReport>();

function retireAgentRunGatewayEventRoutesForMount(mountEpoch: symbol | undefined) {
  if (mountEpoch === undefined) return;
  for (const [storedSessionId, route] of agentRunGatewayEventRouteRegistry) {
    if (route.mountEpoch === mountEpoch) agentRunGatewayEventRouteRegistry.delete(storedSessionId);
  }
}

function suspendAgentRunGatewayEventRoutesForMount(mountEpoch: symbol | undefined) {
  if (mountEpoch === undefined) return;
  for (const route of agentRunGatewayEventRouteRegistry.values()) {
    if (route.mountEpoch === mountEpoch) route.semanticConsumerActive = false;
  }
}

function forgetAgentRunGatewayEventHandoff(storedSessionId: string) {
  agentRunGatewayEventHandoffRegistry.delete(storedSessionId);
}

function createAgentRunGatewayPhysicalDetach(
  storedSessionId: string,
  completionSource: symbol,
  mountEpoch: symbol | undefined,
): AgentRunGatewayPhysicalDetach {
  let settle = () => {};
  let settled = false;
  const detached = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    completionSource,
    detached,
    mountEpoch,
    resolve: () => {
      if (settled) return;
      settled = true;
      settle();
    },
    storedSessionId,
  };
}

function retainAgentRunGatewayEventForHandoff(
  storedSessionId: string,
  completionSource: symbol,
  event: HermesGatewayEvent,
) {
  const existing = agentRunGatewayEventHandoffRegistry.get(storedSessionId);
  // These frames are the only semantic copy of text and lifecycle state that
  // arrives between Workspace mounts. Keep the handoff lossless; takeover,
  // listener retirement, session deletion, and test/app reset clear it.
  if (existing?.completionSource === completionSource) {
    existing.events.push(event);
    return;
  }
  agentRunGatewayEventHandoffRegistry.set(storedSessionId, {
    completionSource,
    events: [event],
  });
}

function takeAgentRunGatewayEventHandoff(storedSessionId: string, completionSource: symbol) {
  const handoff = agentRunGatewayEventHandoffRegistry.get(storedSessionId);
  forgetAgentRunGatewayEventHandoff(storedSessionId);
  return handoff?.completionSource === completionSource ? handoff.events : [];
}

function isPendingAgentRunGatewayApproval(event: HermesGatewayEvent) {
  const classified = classifyHermesEvent(event);
  return classified.kind === "pending_action" && classified.action.kind === "approval";
}

function retireAgentRunGatewayApprovalsAtPhysicalClose(
  ownedGatewayEventSources: ReadonlyMap<string, symbol>,
) {
  for (const [storedSessionId, completionSource] of ownedGatewayEventSources) {
    const handoff = agentRunGatewayEventHandoffRegistry.get(storedSessionId);
    if (handoff?.completionSource === completionSource) {
      handoff.events = handoff.events.filter((event) => !isPendingAgentRunGatewayApproval(event));
      if (handoff.events.length === 0) {
        forgetAgentRunGatewayEventHandoff(storedSessionId);
      }
    }

    const currentRoute = agentRunGatewayEventRouteRegistry.get(storedSessionId);
    if (
      currentRoute?.completionSource !== completionSource ||
      !currentRoute.semanticConsumerActive
    ) {
      continue;
    }
    currentRoute.retireApprovalsAtPhysicalClose();
  }
}

const issueReportPromotionRegistry = new Map<string, IssueReportPromotedDetail>();
const issueReportUiTransitionRegistry: IssueReportUiTransition[] = [];
const MAX_ISSUE_REPORT_UI_TRANSITIONS = 64;
const issueReportDiagnosisRefreshRegistry = new Map<string, IssueReportDiagnosisRefreshRecord>();

function executeDueIssueReportDiagnosisRefresh(record: IssueReportDiagnosisRefreshRecord) {
  if (
    !record.due ||
    record.settled ||
    record.executingGeneration === record.executionGeneration ||
    !record.executor
  ) {
    return;
  }
  const executionGeneration = record.executionGeneration;
  record.executingGeneration = executionGeneration;
  const executor = record.executor;
  const settleExecution = () => {
    if (record.executingGeneration === executionGeneration) {
      record.executingGeneration = undefined;
    }
    if (record.settled) return;
    if (record.executionGeneration !== executionGeneration) {
      executeDueIssueReportDiagnosisRefresh(record);
      return;
    }
    record.settled = true;
    record.resolve();
  };
  void executor(record.transcriptPersistenceProof).then(settleExecution, settleExecution);
}

function releaseIssueReportDiagnosisRefreshClaims(owner: symbol) {
  for (const record of issueReportDiagnosisRefreshRegistry.values()) {
    if (record.owner !== owner) continue;
    record.owner = undefined;
    record.executor = undefined;
    record.executionGeneration += 1;
  }
}
// Delivery of the report being followed up can settle while the Workspace is
// unmounted. Retain that result until the follow-up prompt accepts or rejects.
const deferredFailedIssueReportDeliverySessionIdRegistry = new Set<string>();
// Completed-run continuation ownership must survive navigation. A pending
// zero-delay callback is handed to the replacement Workspace; once delivery
// starts, the original promise may finish, but its outcome is replayed below.
const completedAgentRunContinuationRegistry = new Map<
  string,
  CompletedAgentRunContinuationRecord
>();
const completedAgentRunContinuationClaimSubscribers = new Set<(storedSessionId: string) => void>();
// A queued prompt acknowledgement can outlive the Workspace that started it.
// Retain one head-delivery outcome per session and replay it to the mounted
// queue so an accepted prompt never reappears as a retryable local failure.
const queuedAttachmentFollowUpDeliveryRegistry = new Map<
  string,
  QueuedAttachmentFollowUpDeliveryRecord
>();
const queuedAttachmentFollowUpDeliveryOrder: string[] = [];
const MAX_QUEUED_ATTACHMENT_FOLLOW_UP_DELIVERY_RECORDS = 100;
const queuedAttachmentFollowUpDeliverySubscribers = new Set<
  (record: QueuedAttachmentFollowUpDeliveryRecord) => void
>();
// The monitor outlives this React surface. Retain generation-tagged terminal
// delivery at module lifetime so navigation cannot drop the only event that
// retires a working continuity snapshot. A mounted Workspace consumes the
// record immediately; an offscreen Workspace consumes it on its next mount.
const agentRunMonitorTerminalRegistry = new Map<string, AgentRunMonitorTerminalRecord>();
const agentRunMonitorTerminalSubscribers = new Set<
  (record: AgentRunMonitorTerminalRecord) => void
>();

function rememberIssueReportUiTransition(transition: IssueReportUiTransition) {
  issueReportUiTransitionRegistry.push(transition);
  if (issueReportUiTransitionRegistry.length > MAX_ISSUE_REPORT_UI_TRANSITIONS) {
    issueReportUiTransitionRegistry.splice(
      0,
      issueReportUiTransitionRegistry.length - MAX_ISSUE_REPORT_UI_TRANSITIONS,
    );
  }
}

function forgetIssueReportUiTransition(
  kind: IssueReportUiTransition["kind"],
  detail: IssueReportDeliverySettledDetail | IssueReportFollowUpSubmitFailedDetail,
) {
  const index = issueReportUiTransitionRegistry.findIndex(
    (transition) => transition.kind === kind && transition.detail === detail,
  );
  if (index >= 0) issueReportUiTransitionRegistry.splice(index, 1);
}

function notifyCompletedAgentRunContinuationPending(storedSessionId: string) {
  for (const subscriber of completedAgentRunContinuationClaimSubscribers) {
    subscriber(storedSessionId);
  }
}

function subscribeCompletedAgentRunContinuationClaims(
  subscriber: (storedSessionId: string) => void,
) {
  completedAgentRunContinuationClaimSubscribers.add(subscriber);
  for (const [storedSessionId, continuation] of completedAgentRunContinuationRegistry) {
    if (continuation.phase === "pending" && !continuation.owner) subscriber(storedSessionId);
  }
  return () => {
    completedAgentRunContinuationClaimSubscribers.delete(subscriber);
  };
}

function publishQueuedAttachmentFollowUpDelivery(record: QueuedAttachmentFollowUpDeliveryRecord) {
  queuedAttachmentFollowUpDeliveryRegistry.set(record.queueKey, record);
  const previousIndex = queuedAttachmentFollowUpDeliveryOrder.indexOf(record.queueKey);
  if (previousIndex >= 0) queuedAttachmentFollowUpDeliveryOrder.splice(previousIndex, 1);
  queuedAttachmentFollowUpDeliveryOrder.push(record.queueKey);
  while (
    queuedAttachmentFollowUpDeliveryOrder.length > MAX_QUEUED_ATTACHMENT_FOLLOW_UP_DELIVERY_RECORDS
  ) {
    const evicted = queuedAttachmentFollowUpDeliveryOrder.shift();
    if (evicted) queuedAttachmentFollowUpDeliveryRegistry.delete(evicted);
  }
  for (const subscriber of queuedAttachmentFollowUpDeliverySubscribers) {
    subscriber(record);
  }
}

function subscribeQueuedAttachmentFollowUpDeliveries(
  subscriber: (record: QueuedAttachmentFollowUpDeliveryRecord) => void,
) {
  queuedAttachmentFollowUpDeliverySubscribers.add(subscriber);
  for (const record of queuedAttachmentFollowUpDeliveryRegistry.values()) {
    subscriber(record);
  }
  return () => {
    queuedAttachmentFollowUpDeliverySubscribers.delete(subscriber);
  };
}

function forgetQueuedAttachmentFollowUpDelivery(queueKey: string, itemId?: string) {
  const current = queuedAttachmentFollowUpDeliveryRegistry.get(queueKey);
  if (current && (!itemId || current.itemId === itemId)) {
    queuedAttachmentFollowUpDeliveryRegistry.delete(queueKey);
    const index = queuedAttachmentFollowUpDeliveryOrder.indexOf(queueKey);
    if (index >= 0) queuedAttachmentFollowUpDeliveryOrder.splice(index, 1);
  }
}

function restorePendingIssueReportRegistry(
  reports: Record<string, PendingIssueReport> | undefined,
) {
  for (const [storedSessionId, report] of Object.entries(reports ?? {})) {
    if (!pendingIssueReportRegistry.has(storedSessionId)) {
      pendingIssueReportRegistry.set(storedSessionId, report);
    }
  }
  return pendingIssueReportRegistry;
}

function clearPendingIssueReport(storedSessionId: string, report?: PendingIssueReport) {
  const pending = pendingIssueReportRegistry.get(storedSessionId);
  if (pending && (!report || pending === report)) {
    pendingIssueReportRegistry.delete(storedSessionId);
  }
  const accepted = acceptedPendingIssueReportRegistry.get(storedSessionId);
  if (accepted && (!report || accepted === report)) {
    acceptedPendingIssueReportRegistry.delete(storedSessionId);
  }
}

function agentWorkspaceNeedsTerminalReplay(storedSessionId: string) {
  return (
    agentRunMonitorOwnerRegistry.has(storedSessionId) ||
    pendingAgentRunAcceptanceRegistry.has(storedSessionId) ||
    pendingAgentRunTerminalEvidenceRegistry.has(storedSessionId) ||
    sessionContinuity?.runCompletionSources[storedSessionId] !== undefined ||
    sessionContinuity?.runAuthorityProofs[storedSessionId] !== undefined ||
    sessionContinuity?.runStartRevisions[storedSessionId] !== undefined ||
    Boolean(sessionContinuity?.queuedAttachmentFollowUps[storedSessionId]?.length)
  );
}

function rememberLatestAgentRunGeneration(storedSessionId: string, generation: number) {
  latestAgentRunGenerationRegistry.set(storedSessionId, generation);
  const previousIndex = latestAgentRunGenerationOrder.indexOf(storedSessionId);
  if (previousIndex >= 0) latestAgentRunGenerationOrder.splice(previousIndex, 1);
  latestAgentRunGenerationOrder.push(storedSessionId);
  while (latestAgentRunGenerationRegistry.size > MAX_AGENT_RUN_GENERATION_TOMBSTONES) {
    const evictionIndex = latestAgentRunGenerationOrder.findIndex(
      (storedSessionIdCandidate) => !agentWorkspaceNeedsTerminalReplay(storedSessionIdCandidate),
    );
    if (evictionIndex < 0) return;
    const [evictedStoredSessionId] = latestAgentRunGenerationOrder.splice(evictionIndex, 1);
    latestAgentRunGenerationRegistry.delete(evictedStoredSessionId);
    supersededAgentRunGenerationRegistry.delete(evictedStoredSessionId);
    agentRunMonitorTerminalRegistry.delete(evictedStoredSessionId);
  }
}

function forgetLatestAgentRunGeneration(storedSessionId: string) {
  latestAgentRunGenerationRegistry.delete(storedSessionId);
  supersededAgentRunGenerationRegistry.delete(storedSessionId);
  forgetAgentRunGatewayEventHandoff(storedSessionId);
  const index = latestAgentRunGenerationOrder.indexOf(storedSessionId);
  if (index >= 0) latestAgentRunGenerationOrder.splice(index, 1);
}

function rememberSupersededAgentRunGeneration(storedSessionId: string, generation: number) {
  const current = supersededAgentRunGenerationRegistry.get(storedSessionId);
  if (current === undefined || generation > current) {
    supersededAgentRunGenerationRegistry.set(storedSessionId, generation);
  }
}

function takeDeferredPendingAcceptancePredecessorTerminal(
  storedSessionId: string,
  acceptance: PendingAgentRunAcceptance,
) {
  const deferred = acceptance.deferredPredecessorMonitorTerminal;
  const generation = acceptance.predecessorRunMonitorGeneration;
  acceptance.deferredPredecessorMonitorTerminal = undefined;
  if (generation !== undefined) retireAgentRunMonitorTerminal(storedSessionId, generation);
  return deferred;
}

function supersedePendingAcceptancePredecessor(
  storedSessionId: string,
  acceptance: PendingAgentRunAcceptance,
) {
  takeDeferredPendingAcceptancePredecessorTerminal(storedSessionId, acceptance);
  const generation = acceptance.predecessorRunMonitorGeneration;
  if (generation === undefined) return;
  cancelAgentRunMonitoring(storedSessionId, generation);
  if (agentRunMonitorOwnerRegistry.get(storedSessionId) === acceptance.predecessorMonitorOwner) {
    agentRunMonitorOwnerRegistry.delete(storedSessionId);
  }
  rememberSupersededAgentRunGeneration(storedSessionId, generation);
}

function retireAgentRunMonitorTerminal(storedSessionId: string, runMonitorGeneration: number) {
  const terminal = agentRunMonitorTerminalRegistry.get(storedSessionId);
  if (terminal?.detail.runMonitorGeneration === runMonitorGeneration) {
    agentRunMonitorTerminalRegistry.delete(storedSessionId);
  }
}

function agentRunTerminalDispatchSuppressed(record: AgentRunMonitorTerminalRecord) {
  const detail = record.detail;
  const storedSessionId = detail?.sessionId;
  const runMonitorGeneration = detail?.runMonitorGeneration;
  if (!storedSessionId || runMonitorGeneration === undefined) return false;
  const supersededGeneration = supersededAgentRunGenerationRegistry.get(storedSessionId);
  if (supersededGeneration !== undefined && runMonitorGeneration <= supersededGeneration) {
    return true;
  }
  const latestGeneration = latestAgentRunGenerationRegistry.get(storedSessionId);
  if (latestGeneration !== undefined && runMonitorGeneration < latestGeneration) return true;
  const pendingAcceptance = pendingAgentRunAcceptanceRegistry.get(storedSessionId);
  if (pendingAcceptance?.predecessorRunMonitorGeneration !== runMonitorGeneration) return false;
  pendingAcceptance.deferredPredecessorMonitorTerminal = record;
  return true;
}

registerAgentRunTerminalDispatchGuard(
  (dispatch: AgentRunTerminalDispatch) => !agentRunTerminalDispatchSuppressed(dispatch),
);

function publishAgentRunMonitorTerminal(record: AgentRunMonitorTerminalRecord) {
  const detail = record.detail;
  if (!detail?.sessionId || detail.runMonitorGeneration === undefined) return;
  const storedSessionId = detail.sessionId;
  const runMonitorGeneration = detail.runMonitorGeneration;
  if (
    record.kind === "status" &&
    record.detail.status !== "failed" &&
    record.detail.status !== "cancelled"
  ) {
    return;
  }
  if (agentRunTerminalDispatchSuppressed(record)) return;
  const owner = agentRunMonitorOwnerRegistry.get(storedSessionId);
  const latestGeneration = latestAgentRunGenerationRegistry.get(storedSessionId);
  const knownGeneration = Math.max(
    owner?.generation ?? Number.NEGATIVE_INFINITY,
    latestGeneration ?? Number.NEGATIVE_INFINITY,
  );
  if (Number.isFinite(knownGeneration) && runMonitorGeneration < knownGeneration) return;
  rememberLatestAgentRunGeneration(storedSessionId, runMonitorGeneration);
  if (!Number.isFinite(knownGeneration) || runMonitorGeneration > knownGeneration) {
    const pendingAcceptance = pendingAgentRunAcceptanceRegistry.get(storedSessionId);
    pendingAcceptance?.rejectWithCurrentListener?.();
    if (pendingAgentRunAcceptanceRegistry.get(storedSessionId) === pendingAcceptance) {
      pendingAgentRunAcceptanceRegistry.delete(storedSessionId);
      pendingAgentRunTerminalEvidenceRegistry.delete(storedSessionId);
    }
  }
  const terminalStatus = record.kind === "status" ? record.detail.status : "completed";
  const receivedAt = new Date().toISOString();
  const mode = hermesActivityStore.getRecord(storedSessionId)?.mode ?? "sandboxed";
  if (terminalStatus === "failed") {
    hermesActivityStore.record(
      {
        kind: "error",
        sessionId: storedSessionId,
        message:
          (record.kind === "status" && record.detail.summary?.trim()) || "June hit a problem.",
        receivedAt,
      },
      mode,
    );
  } else {
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: storedSessionId,
        flavor: "terminal",
        status: terminalStatus,
        text: "",
        receivedAt,
      },
      mode,
    );
  }
  pendingActionStore.resolveSession(storedSessionId);
  agentRunMonitorTerminalRegistry.set(storedSessionId, record);
  for (const subscriber of agentRunMonitorTerminalSubscribers) subscriber(record);
  // A first terminal can beat startAgentRunMonitoring's queued start event.
  // Keep its tombstone through this microtask so an equal late start cannot
  // resurrect activity, then release NoteChat-only state that no Workspace
  // owner or continuity snapshot needs to replay on remount.
  queueMicrotask(() => {
    if (!agentWorkspaceNeedsTerminalReplay(storedSessionId)) {
      retireAgentRunMonitorTerminal(storedSessionId, runMonitorGeneration);
    }
  });
}

function subscribeAgentRunMonitorTerminals(
  subscriber: (record: AgentRunMonitorTerminalRecord) => void,
) {
  agentRunMonitorTerminalSubscribers.add(subscriber);
  for (const record of agentRunMonitorTerminalRegistry.values()) subscriber(record);
  return () => {
    agentRunMonitorTerminalSubscribers.delete(subscriber);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener(AGENT_RUN_STARTED_EVENT, (event) => {
    const detail = (event as CustomEvent<AgentRunStartedDetail>).detail;
    if (!detail?.storedSessionId || detail.runMonitorGeneration === undefined) return;
    const latestGeneration = latestAgentRunGenerationRegistry.get(detail.storedSessionId);
    if (latestGeneration !== undefined && latestGeneration >= detail.runMonitorGeneration) return;
    rememberLatestAgentRunGeneration(detail.storedSessionId, detail.runMonitorGeneration);
    const pendingAcceptance = pendingAgentRunAcceptanceRegistry.get(detail.storedSessionId);
    pendingAcceptance?.rejectWithCurrentListener?.();
    if (pendingAgentRunAcceptanceRegistry.get(detail.storedSessionId) === pendingAcceptance) {
      pendingAgentRunAcceptanceRegistry.delete(detail.storedSessionId);
      pendingAgentRunTerminalEvidenceRegistry.delete(detail.storedSessionId);
    }
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: detail.storedSessionId,
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: new Date().toISOString(),
      },
      detail.fullMode ? "unrestricted" : "sandboxed",
    );
    const pendingTerminal = agentRunMonitorTerminalRegistry.get(detail.storedSessionId);
    const pendingTerminalGeneration = pendingTerminal?.detail.runMonitorGeneration;
    if (
      pendingTerminal &&
      pendingTerminalGeneration !== undefined &&
      pendingTerminalGeneration < detail.runMonitorGeneration
    ) {
      agentRunMonitorTerminalRegistry.delete(detail.storedSessionId);
    }
  });
  window.addEventListener(AGENT_SESSION_STATUS_EVENT, (event) => {
    publishAgentRunMonitorTerminal({
      kind: "status",
      detail: (event as CustomEvent<AgentSessionStatusDetail>).detail,
    });
  });
  window.addEventListener(AGENT_RUN_SETTLED_EVENT, (event) => {
    publishAgentRunMonitorTerminal({
      kind: "settled",
      detail: (event as CustomEvent<AgentRunSettledDetail>).detail,
    });
  });
}
const NEW_SESSION_DRAFT_KEY = "new-session";
const NEW_SESSION_RECOVERY_QUEUE_KEY = "new-session-recovery";
const NEW_SESSION_DRAFT_STORAGE_KEY = "june:agent:new-session-draft";
const REVIEWABLE_ISSUE_REPORTS_STORAGE_KEY = "june:agent:reviewable-issue-reports";
const IMAGE_SLASH_TURNS_STORAGE_KEY = "june:agent:image-slash-turns";
const VIDEO_SLASH_TURNS_STORAGE_KEY = "june:agent:video-slash-turns";
const ISSUE_REPORT_DELIVERY_SETTLED_EVENT = "june-agent-issue-report-delivery-settled";
const ISSUE_REPORT_PROMOTED_EVENT = "june-agent-issue-report-promoted";
const ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT =
  "june-agent-issue-report-follow-up-submit-failed";
const ISSUE_REPORT_SENT_MESSAGE =
  "Your report was sent to the June team. Thank you for helping improve June.";

/** Success copy for a delivered report; names files that could not be attached
 * in Open Software (JUN-238: a skipped file must never be a silent drop). */
function issueReportSentMessage(skippedAttachmentNames: string[] | undefined) {
  if (!skippedAttachmentNames?.length) return ISSUE_REPORT_SENT_MESSAGE;
  return `${ISSUE_REPORT_SENT_MESSAGE} These files could not be attached to the report in Open Software and were sent by name only: ${skippedAttachmentNames.join(", ")}.`;
}
const ISSUE_REPORT_DIAGNOSIS_REFRESH_TIMEOUT_MS = 1500;
const ISSUE_REPORT_DIAGNOSIS_BOUNDARY_SKEW_MS = 1500;
const agentComposerDrafts = new Map<string, ComposerDraftSnapshot>();

function sessionComposerDraftKey(sessionId: string) {
  return `session:${sessionId}`;
}

function rememberComposerDraft(
  key: string | null,
  text: string,
  category: ReportCategory | null,
  attachments: AgentAttachment[] = [],
) {
  if (!key) return;
  if (!text.trim() && !category && attachments.length === 0) {
    agentComposerDrafts.delete(key);
    if (key === NEW_SESSION_DRAFT_KEY) removeStoredNewSessionDraft();
    return;
  }
  const snapshot = {
    text,
    category,
    attachments: [...attachments],
  };
  agentComposerDrafts.set(key, snapshot);
  if (key === NEW_SESSION_DRAFT_KEY) writeStoredNewSessionDraft(snapshot);
}

function forgetComposerDraft(key: string | null) {
  if (!key) return;
  agentComposerDrafts.delete(key);
  if (key === NEW_SESSION_DRAFT_KEY) removeStoredNewSessionDraft();
}

function moveComposerDraft(fromKey: string | null, toKey: string | null) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const snapshot = readComposerDraft(fromKey);
  if (!snapshot) return;
  rememberComposerDraft(toKey, snapshot.text, snapshot.category, snapshot.attachments ?? []);
  forgetComposerDraft(fromKey);
}

function readComposerDraft(key: string | null) {
  if (!key) return undefined;
  const snapshot = agentComposerDrafts.get(key);
  if (snapshot || key !== NEW_SESSION_DRAFT_KEY) return snapshot;
  const storedSnapshot = readStoredNewSessionDraft();
  if (storedSnapshot) agentComposerDrafts.set(key, storedSnapshot);
  return storedSnapshot;
}

function hasNewSessionComposerDraft() {
  return Boolean(agentComposerDrafts.get(NEW_SESSION_DRAFT_KEY) ?? readStoredNewSessionDraft());
}

function writeStoredNewSessionDraft(snapshot: ComposerDraftSnapshot) {
  const text = snapshot.text;
  const category = snapshot.category;
  if (!text.trim() && !category) {
    removeStoredNewSessionDraft();
    return;
  }
  try {
    window.sessionStorage.setItem(
      NEW_SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({ text, category }),
    );
  } catch {
    // Storage can be unavailable in restricted webviews; the in-memory draft
    // still covers ordinary view switches in this process.
  }
}

function readStoredNewSessionDraft(): ComposerDraftSnapshot | undefined {
  try {
    const value = window.sessionStorage.getItem(NEW_SESSION_DRAFT_STORAGE_KEY);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as { text?: unknown; category?: unknown };
    const text = typeof parsed.text === "string" ? parsed.text : "";
    const category = isReportCategory(parsed.category) ? parsed.category : null;
    if (!text.trim() && !category) {
      removeStoredNewSessionDraft();
      return undefined;
    }
    return { text, category, attachments: [] };
  } catch {
    removeStoredNewSessionDraft();
    return undefined;
  }
}

function removeStoredNewSessionDraft() {
  try {
    window.sessionStorage.removeItem(NEW_SESSION_DRAFT_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in restricted webviews.
  }
}

function activeHermesActivitySessionIds() {
  const activeIds = new Set<string>();
  for (const record of hermesActivityStore.getRecords()) {
    if (record.phase === "running" || record.phase === "waiting" || record.phase === "background") {
      activeIds.add(record.sessionId);
    }
  }
  return activeIds;
}

function hermesLiveStreamNeedsContinuity(stream: HermesLiveStream) {
  for (const { event } of stream.entries) {
    if (event.kind === "transcript") {
      if (event.complete && event.failed) return true;
      if (!event.messageId || !stream.persistedMessageIds[event.messageId]) return true;
      continue;
    }
    if (event.kind === "lifecycle" || event.kind === "unsupported") continue;
    // Persisted message reconciliation can prove ownership only for transcript
    // entries. Keep every renderable structured entry until June has an
    // equivalent persisted authority, otherwise a settled remount can erase a
    // tool-only, reasoning-only, media, or action output.
    return true;
  }
  return false;
}

function hermesLiveStreamHasReplayLedger(stream: HermesLiveStream) {
  return stream.seenDeliveries.size > 0;
}

function compactHermesLiveStreamToReplayLedger(stream: HermesLiveStream): HermesLiveStream {
  return {
    ...createHermesLiveStream(),
    revision: stream.revision,
    seenDeliveries: stream.seenDeliveries,
  };
}

function shouldOpenNewSessionOnMount() {
  return hasPendingNewSessionRequest() || hasNewSessionComposerDraft();
}

function captureSessionContinuity(state: {
  sessionItems: HermesSessionInfo[];
  pendingMessages: Record<string, HermesSessionMessage[]>;
  runtimeSessionIds: Record<string, string>;
  liveEvents: Record<string, HermesLiveStream>;
  runStartRevisions: Record<string, number>;
  runAuthorityProofs: Record<string, AgentRunAuthorityProof>;
  runCompletionSources: Record<string, symbol>;
  terminalFingerprints: Record<string, string[]>;
  titleOverrides: Record<string, string>;
  titleSources: Record<string, AgentSessionTitleSource>;
  pendingIssueReports: Record<string, PendingIssueReport>;
  reviewableIssueReports: Record<string, PendingIssueReport>;
  diagnosisRefreshIssueReportSessionIds: Set<string>;
  submittingIssueReportSessionIds: Set<string>;
  queuedAttachmentFollowUps: Record<string, QueuedAttachmentFollowUp[]>;
}): AgentSessionContinuity | null {
  const activeIds = activeHermesActivitySessionIds();
  for (const [sessionId, pending] of Object.entries(state.pendingMessages)) {
    if (pending.length > 0) activeIds.add(sessionId);
  }
  for (const sessionId of Object.keys(state.reviewableIssueReports)) {
    activeIds.add(sessionId);
  }
  for (const sessionId of Object.keys(state.pendingIssueReports)) {
    activeIds.add(sessionId);
  }
  for (const sessionId of state.diagnosisRefreshIssueReportSessionIds) {
    activeIds.add(sessionId);
  }
  for (const sessionId of state.submittingIssueReportSessionIds) {
    activeIds.add(sessionId);
  }
  for (const [sessionId, queued] of Object.entries(state.queuedAttachmentFollowUps)) {
    if (queued.length > 0) activeIds.add(sessionId);
  }
  for (const sessionId of Object.keys(state.runStartRevisions)) {
    activeIds.add(sessionId);
  }
  for (const sessionId of Object.keys(state.runAuthorityProofs)) {
    activeIds.add(sessionId);
  }
  for (const sessionId of Object.keys(state.runCompletionSources)) {
    activeIds.add(sessionId);
  }
  for (const [sessionId, stream] of Object.entries(state.liveEvents)) {
    if (hermesLiveStreamNeedsContinuity(stream)) activeIds.add(sessionId);
  }
  const hasReplayContinuity =
    Object.keys(state.terminalFingerprints).length > 0 ||
    Object.values(state.liveEvents).some(hermesLiveStreamHasReplayLedger);
  if (activeIds.size === 0 && !hasReplayContinuity) return null;
  const pick = <T,>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([sessionId]) => activeIds.has(sessionId)));
  const liveEvents = Object.fromEntries(
    Object.entries(state.liveEvents).flatMap(([sessionId, stream]) => {
      if (
        activeIds.has(sessionId) &&
        (hermesLiveStreamNeedsContinuity(stream) ||
          state.runStartRevisions[sessionId] !== undefined)
      ) {
        return [[sessionId, stream] as const];
      }
      return hermesLiveStreamHasReplayLedger(stream)
        ? [[sessionId, compactHermesLiveStreamToReplayLedger(stream)] as const]
        : [];
    }),
  );
  return {
    sessionItems: state.sessionItems.filter((session) => activeIds.has(session.id)),
    pendingMessages: pick(state.pendingMessages),
    runtimeSessionIds: pick(state.runtimeSessionIds),
    liveEvents,
    runStartRevisions: pick(state.runStartRevisions),
    runAuthorityProofs: pick(state.runAuthorityProofs),
    runCompletionSources: pick(state.runCompletionSources),
    terminalFingerprints: { ...state.terminalFingerprints },
    titleOverrides: pick(state.titleOverrides),
    titleSources: pick(state.titleSources),
    pendingIssueReports: pick(state.pendingIssueReports),
    reviewableIssueReports: pick(state.reviewableIssueReports),
    diagnosisRefreshIssueReportSessionIds: [...state.diagnosisRefreshIssueReportSessionIds].filter(
      (sessionId) => activeIds.has(sessionId),
    ),
    submittingIssueReportSessionIds: [...state.submittingIssueReportSessionIds].filter(
      (sessionId) => activeIds.has(sessionId),
    ),
    queuedAttachmentFollowUps: pick(state.queuedAttachmentFollowUps),
  };
}

function persistedReviewableIssueReports(): Record<string, PendingIssueReport> {
  try {
    const raw = window.localStorage.getItem(REVIEWABLE_ISSUE_REPORTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([sessionId, value]) => [sessionId, persistedIssueReport(value)])
        .filter(
          (entry): entry is [string, PendingIssueReport] =>
            typeof entry[0] === "string" && entry[1] !== undefined,
        ),
    );
  } catch {
    return {};
  }
}

function persistReviewableIssueReports(reports: Record<string, PendingIssueReport>) {
  try {
    const entries = Object.entries(reports);
    if (entries.length === 0) {
      window.localStorage.removeItem(REVIEWABLE_ISSUE_REPORTS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      REVIEWABLE_ISSUE_REPORTS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Best-effort: app reload restore can fail without blocking the report flow.
  }
}

function persistedIssueReport(value: unknown): PendingIssueReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<PendingIssueReport>;
  if (
    !isReportCategory(candidate.category) ||
    typeof candidate.description !== "string" ||
    !Array.isArray(candidate.followUps) ||
    !Array.isArray(candidate.attachmentNames) ||
    !Array.isArray(candidate.attachmentPaths)
  ) {
    return undefined;
  }
  const followUps = candidate.followUps.filter(
    (followUp): followUp is string => typeof followUp === "string",
  );
  const attachmentNames = candidate.attachmentNames.filter(
    (name): name is string => typeof name === "string",
  );
  const attachmentPaths = candidate.attachmentPaths.filter(
    (path): path is string => typeof path === "string",
  );
  return {
    category: candidate.category,
    description: candidate.description,
    followUps,
    attachmentNames,
    attachmentPaths,
    ...(typeof candidate.diagnosisStartedAt === "string"
      ? { diagnosisStartedAt: candidate.diagnosisStartedAt }
      : {}),
  };
}

function updateContinuityAfterIssueReportDelivery(detail: IssueReportDeliverySettledDetail) {
  if (detail.result.sent) {
    deferredFailedIssueReportDeliverySessionIdRegistry.delete(detail.storedSessionId);
  } else if (pendingIssueReportRegistry.has(detail.storedSessionId)) {
    deferredFailedIssueReportDeliverySessionIdRegistry.add(detail.storedSessionId);
  }
  if (!sessionContinuity) return;
  const reviewableIssueReports = {
    ...sessionContinuity.reviewableIssueReports,
  };
  const pendingIssueReports = Object.fromEntries(pendingIssueReportRegistry);
  const diagnosisRefreshIssueReportSessionIds = new Set(
    sessionContinuity.diagnosisRefreshIssueReportSessionIds,
  );
  if (detail.result.sent && reviewableIssueReports[detail.storedSessionId] === detail.report) {
    delete reviewableIssueReports[detail.storedSessionId];
    diagnosisRefreshIssueReportSessionIds.delete(detail.storedSessionId);
  } else if (!detail.result.sent && !pendingIssueReports[detail.storedSessionId]) {
    reviewableIssueReports[detail.storedSessionId] =
      reviewableIssueReports[detail.storedSessionId] ?? detail.report;
  }
  persistReviewableIssueReports(reviewableIssueReports);
  sessionContinuity = captureSessionContinuity({
    sessionItems: sessionContinuity.sessionItems,
    pendingMessages: sessionContinuity.pendingMessages,
    runtimeSessionIds: sessionContinuity.runtimeSessionIds,
    liveEvents: sessionContinuity.liveEvents,
    runStartRevisions: sessionContinuity.runStartRevisions,
    runAuthorityProofs: sessionContinuity.runAuthorityProofs,
    runCompletionSources: sessionContinuity.runCompletionSources,
    terminalFingerprints: sessionContinuity.terminalFingerprints,
    titleOverrides: sessionContinuity.titleOverrides,
    titleSources: sessionContinuity.titleSources,
    pendingIssueReports,
    reviewableIssueReports,
    diagnosisRefreshIssueReportSessionIds,
    submittingIssueReportSessionIds: new Set(
      sessionContinuity.submittingIssueReportSessionIds.filter(
        (sessionId) => sessionId !== detail.storedSessionId,
      ),
    ),
    queuedAttachmentFollowUps: sessionContinuity.queuedAttachmentFollowUps,
  });
}

function updateContinuityAfterIssueReportPromoted(detail: IssueReportPromotedDetail) {
  const persistedReports = {
    ...persistedReviewableIssueReports(),
    [detail.storedSessionId]: detail.report,
  };
  persistReviewableIssueReports(persistedReports);
  if (!sessionContinuity) return;
  const diagnosisRefreshIssueReportSessionIds = new Set(
    sessionContinuity.diagnosisRefreshIssueReportSessionIds,
  );
  if (detail.queueDiagnosisRefresh) {
    diagnosisRefreshIssueReportSessionIds.add(detail.storedSessionId);
  } else {
    diagnosisRefreshIssueReportSessionIds.delete(detail.storedSessionId);
  }
  sessionContinuity = captureSessionContinuity({
    sessionItems: sessionContinuity.sessionItems,
    pendingMessages: sessionContinuity.pendingMessages,
    runtimeSessionIds: sessionContinuity.runtimeSessionIds,
    liveEvents: sessionContinuity.liveEvents,
    runStartRevisions: sessionContinuity.runStartRevisions,
    runAuthorityProofs: sessionContinuity.runAuthorityProofs,
    runCompletionSources: sessionContinuity.runCompletionSources,
    terminalFingerprints: sessionContinuity.terminalFingerprints,
    titleOverrides: sessionContinuity.titleOverrides,
    titleSources: sessionContinuity.titleSources,
    pendingIssueReports: Object.fromEntries(pendingIssueReportRegistry),
    reviewableIssueReports: {
      ...sessionContinuity.reviewableIssueReports,
      [detail.storedSessionId]: detail.report,
    },
    diagnosisRefreshIssueReportSessionIds,
    submittingIssueReportSessionIds: new Set(sessionContinuity.submittingIssueReportSessionIds),
    queuedAttachmentFollowUps: sessionContinuity.queuedAttachmentFollowUps,
  });
}

function updateContinuityAfterIssueReportFollowUpSubmitFailed(
  detail: IssueReportFollowUpSubmitFailedDetail,
) {
  clearPendingIssueReport(detail.storedSessionId, detail.queuedReport);
  deferredFailedIssueReportDeliverySessionIdRegistry.delete(detail.storedSessionId);
  if (!sessionContinuity) return;
  const pendingIssueReports = Object.fromEntries(pendingIssueReportRegistry);
  const reviewableIssueReports = {
    ...sessionContinuity.reviewableIssueReports,
  };
  if (detail.restoreReport && !reviewableIssueReports[detail.storedSessionId]) {
    reviewableIssueReports[detail.storedSessionId] = detail.restoreReport;
  }
  persistReviewableIssueReports(reviewableIssueReports);
  sessionContinuity = captureSessionContinuity({
    sessionItems: sessionContinuity.sessionItems,
    pendingMessages: sessionContinuity.pendingMessages,
    runtimeSessionIds: sessionContinuity.runtimeSessionIds,
    liveEvents: sessionContinuity.liveEvents,
    runStartRevisions: sessionContinuity.runStartRevisions,
    runAuthorityProofs: sessionContinuity.runAuthorityProofs,
    runCompletionSources: sessionContinuity.runCompletionSources,
    terminalFingerprints: sessionContinuity.terminalFingerprints,
    titleOverrides: sessionContinuity.titleOverrides,
    titleSources: sessionContinuity.titleSources,
    pendingIssueReports,
    reviewableIssueReports,
    diagnosisRefreshIssueReportSessionIds: new Set(
      sessionContinuity.diagnosisRefreshIssueReportSessionIds,
    ),
    submittingIssueReportSessionIds: new Set(sessionContinuity.submittingIssueReportSessionIds),
    queuedAttachmentFollowUps: sessionContinuity.queuedAttachmentFollowUps,
  });
}

/** stored session id (not the runtime session id). */
export function recordManualAgentSessionTitle(sessionId: string, title: string) {
  if (!sessionContinuity) return;
  sessionContinuity = captureSessionContinuity({
    sessionItems: sessionContinuity.sessionItems.map((session) =>
      session.id === sessionId ? { ...session, title } : session,
    ),
    pendingMessages: sessionContinuity.pendingMessages,
    runtimeSessionIds: sessionContinuity.runtimeSessionIds,
    liveEvents: sessionContinuity.liveEvents,
    runStartRevisions: sessionContinuity.runStartRevisions,
    runAuthorityProofs: sessionContinuity.runAuthorityProofs,
    runCompletionSources: sessionContinuity.runCompletionSources,
    terminalFingerprints: sessionContinuity.terminalFingerprints,
    titleOverrides: {
      ...sessionContinuity.titleOverrides,
      [sessionId]: title,
    },
    titleSources: {
      ...sessionContinuity.titleSources,
      [sessionId]: "manual",
    },
    pendingIssueReports: sessionContinuity.pendingIssueReports,
    reviewableIssueReports: sessionContinuity.reviewableIssueReports,
    diagnosisRefreshIssueReportSessionIds: new Set(
      sessionContinuity.diagnosisRefreshIssueReportSessionIds,
    ),
    submittingIssueReportSessionIds: new Set(sessionContinuity.submittingIssueReportSessionIds),
    queuedAttachmentFollowUps: sessionContinuity.queuedAttachmentFollowUps,
  });
}

function dispatchIssueReportDeliverySettled(detail: IssueReportDeliverySettledDetail) {
  rememberIssueReportUiTransition({ kind: "delivery-settled", detail });
  updateContinuityAfterIssueReportDelivery(detail);
  window.dispatchEvent(
    new CustomEvent<IssueReportDeliverySettledDetail>(ISSUE_REPORT_DELIVERY_SETTLED_EVENT, {
      detail,
    }),
  );
}

function dispatchIssueReportPromoted(detail: IssueReportPromotedDetail) {
  issueReportPromotionRegistry.set(detail.storedSessionId, detail);
  updateContinuityAfterIssueReportPromoted(detail);
  window.dispatchEvent(
    new CustomEvent<IssueReportPromotedDetail>(ISSUE_REPORT_PROMOTED_EVENT, { detail }),
  );
}

function dispatchIssueReportFollowUpSubmitFailed(detail: IssueReportFollowUpSubmitFailedDetail) {
  rememberIssueReportUiTransition({ kind: "follow-up-submit-failed", detail });
  updateContinuityAfterIssueReportFollowUpSubmitFailed(detail);
  window.dispatchEvent(
    new CustomEvent<IssueReportFollowUpSubmitFailedDetail>(
      ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT,
      { detail },
    ),
  );
}

/** Test hook: publish through the production promotion handoff so tests can
 * place the event precisely between render state initialization and passive
 * effect subscription. */
export function dispatchIssueReportPromotedForTest(detail: IssueReportPromotedDetail) {
  dispatchIssueReportPromoted(detail);
}

/** Test hook: publish through the production delivery-settlement ledger so
 * tests can exercise deterministic mount-boundary replay. */
export function dispatchIssueReportDeliverySettledForTest(
  detail: IssueReportDeliverySettledDetail,
) {
  dispatchIssueReportDeliverySettled(detail);
}

/** Test hook: publish through the production follow-up failure ledger so
 * tests can exercise deterministic mount-boundary replay. */
export function dispatchIssueReportFollowUpSubmitFailedForTest(
  detail: IssueReportFollowUpSubmitFailedDetail,
) {
  dispatchIssueReportFollowUpSubmitFailed(detail);
}

function issueReportDescription(report: PendingIssueReport) {
  const followUps = report.followUps.map((followUp) => followUp.trim()).filter(Boolean);
  if (followUps.length === 0) return report.description;
  return [
    report.description,
    "",
    "Follow-up comments:",
    ...followUps.map((followUp, index) => `${index + 1}. ${followUp}`),
  ].join("\n");
}

function appendIssueReportFollowUp(
  report: PendingIssueReport,
  followUp: string,
  attachmentNames: string[],
  attachmentPaths: string[],
): PendingIssueReport {
  return {
    ...report,
    followUps: [
      ...report.followUps,
      followUp.trim() || "No follow-up text was typed; see the attachments.",
    ],
    attachmentNames: [...report.attachmentNames, ...attachmentNames],
    attachmentPaths: [...report.attachmentPaths, ...attachmentPaths],
  };
}

function messageAfterIssueReportDiagnosisBoundary(
  message: HermesSessionMessage,
  report: PendingIssueReport,
) {
  if (!report.diagnosisStartedAt) return true;
  const messageTime = hermesMessageTimestampMs(message);
  const boundaryTime = Date.parse(report.diagnosisStartedAt);
  if (!Number.isFinite(boundaryTime)) return true;
  return (
    messageTime !== undefined &&
    messageTime >= boundaryTime - ISSUE_REPORT_DIAGNOSIS_BOUNDARY_SKEW_MS
  );
}

/** Test hook: the snapshot is module state, so a test that unmounts with a
 * working session (testing-library auto-cleanup) would otherwise leak it into
 * the next test's mount. */
export function resetAgentSessionContinuity() {
  for (const items of Object.values(sessionContinuity?.queuedAttachmentFollowUps ?? {})) {
    for (const item of items) item.dispatchReservation?.cancel();
  }
  for (const continuation of completedAgentRunContinuationRegistry.values()) {
    if (continuation.timer !== undefined) window.clearTimeout(continuation.timer);
    continuation.resolveDeliverySettled?.();
  }
  sessionContinuity = null;
  pendingAgentRunTerminalEvidenceRegistry.clear();
  pendingAgentRunAcceptanceRegistry.clear();
  agentRunMonitorOwnerRegistry.clear();
  agentRunGatewayEventRouteRegistry.clear();
  agentRunGatewayEventHandoffRegistry.clear();
  for (const detach of agentRunGatewayPhysicalDetachRegistry.values()) detach.resolve();
  agentRunGatewayPhysicalDetachRegistry.clear();
  latestAgentRunGenerationRegistry.clear();
  latestAgentRunGenerationOrder.length = 0;
  supersededAgentRunGenerationRegistry.clear();
  agentRunMonitorTerminalRegistry.clear();
  pendingIssueReportRegistry.clear();
  acceptedPendingIssueReportRegistry.clear();
  issueReportPromotionRegistry.clear();
  issueReportUiTransitionRegistry.length = 0;
  for (const refresh of issueReportDiagnosisRefreshRegistry.values()) {
    window.clearTimeout(refresh.timer);
    refresh.resolve();
  }
  issueReportDiagnosisRefreshRegistry.clear();
  deferredFailedIssueReportDeliverySessionIdRegistry.clear();
  completedAgentRunContinuationRegistry.clear();
  queuedAttachmentFollowUpDeliveryRegistry.clear();
  queuedAttachmentFollowUpDeliveryOrder.length = 0;
  agentComposerDrafts.clear();
  removeStoredNewSessionDraft();
  for (const record of hermesActivityStore.getRecords()) {
    hermesActivityStore.clearSession(record.sessionId);
  }
}

export function seedAgentComposerDraftForTest(
  key: string,
  snapshot: {
    text: string;
    category: ReportCategory | null;
    attachments?: AgentAttachment[];
  },
) {
  rememberComposerDraft(key, snapshot.text, snapshot.category, snapshot.attachments ?? []);
}

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
  const [continuity] = useState(() => sessionContinuity);
  // Async reconciliation is component-local: its message and continuation
  // refs are replaced when navigation remounts the Workspace. Give each mount
  // an epoch so an old poll cannot settle shared run state or consume the old
  // copy of a follow-up queue after the replacement mount takes ownership.
  const workspaceMountEpochRef = useRef<symbol | undefined>(undefined);
  const claimCompletedAgentRunContinuationRef = useRef<(storedSessionId: string) => void>(() => {});
  claimCompletedAgentRunContinuationRef.current = claimCompletedAgentRunContinuation;
  useLayoutEffect(() => {
    const epoch = Symbol("AgentWorkspace mount");
    workspaceMountEpochRef.current = epoch;
    const unsubscribe = subscribeCompletedAgentRunContinuationClaims((storedSessionId) => {
      claimCompletedAgentRunContinuationRef.current(storedSessionId);
    });
    return () => {
      unsubscribe();
      releasePendingCompletedAgentRunContinuations(epoch);
      releaseIssueReportDiagnosisRefreshClaims(epoch);
      if (workspaceMountEpochRef.current === epoch) {
        workspaceMountEpochRef.current = undefined;
      }
    };
  }, []);
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
  useEffect(() => {
    if (!bridge.running) return;
    for (const [storedSessionId, continuation] of completedAgentRunContinuationRegistry) {
      if (continuation.phase === "pending" && !continuation.owner) {
        claimCompletedAgentRunContinuationRef.current(storedSessionId);
      }
    }
  }, [bridge.running]);
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
  const [liveEvents, setLiveEvents] = useState<Record<string, HermesLiveStream>>(
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
  // Once a stored-session FIFO dispatch starts, cancel() can no longer release
  // it. Keep the socket alive across unmount until every such dispatch settles,
  // including its resume/configuration work and prompt acknowledgement.
  const inFlightSessionDispatchesRef = useRef(new Set<Promise<void>>());
  const trackInFlightSessionDispatch = useCallback(
    async <Result,>(sessionDispatch: Promise<Result>) => {
      const sessionDispatchSettled = sessionDispatch.then(
        () => undefined,
        () => undefined,
      );
      inFlightSessionDispatchesRef.current.add(sessionDispatchSettled);
      try {
        return await sessionDispatch;
      } finally {
        inFlightSessionDispatchesRef.current.delete(sessionDispatchSettled);
      }
    },
    [],
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
      Object.entries(continuity?.queuedAttachmentFollowUps ?? {}).flatMap(([sessionId, items]) => {
        const delivery = queuedAttachmentFollowUpDeliveryRegistry.get(sessionId);
        const restored = items.flatMap((item): QueuedAttachmentFollowUp[] => {
          if (delivery?.itemId === item.id) {
            if (delivery.status === "sent") return [];
            if (delivery.status === "sending") {
              return [
                {
                  ...item,
                  attachments: delivery.attachments ?? item.attachments,
                  status: "sending",
                  error: undefined,
                },
              ];
            }
            return [
              {
                ...item,
                attachments: delivery.attachments ?? item.attachments,
                dispatchReservation: undefined,
                status: "failed",
                error: delivery.error ?? "Delivery was interrupted. Try again.",
              },
            ];
          }
          return item.status === "sending"
            ? [
                {
                  ...item,
                  dispatchReservation: undefined,
                  status: "failed",
                  error: "Delivery was interrupted. Try again.",
                },
              ]
            : [item];
        });
        return restored.length ? [[sessionId, restored] as const] : [];
      }),
    ),
  );
  const queuedAttachmentFollowUpsRef = useRef(queuedAttachmentFollowUps);
  useEffect(
    () =>
      subscribeQueuedAttachmentFollowUpDeliveries((delivery) => {
        const queued = queuedAttachmentFollowUpsRef.current[delivery.queueKey] ?? [];
        if (!queued.some((item) => item.id === delivery.itemId)) {
          if (delivery.status !== "sending") {
            forgetQueuedAttachmentFollowUpDelivery(delivery.queueKey, delivery.itemId);
          }
          return;
        }
        updateQueuedAttachmentFollowUps(delivery.queueKey, (items) => {
          if (delivery.status === "sent") {
            return items.filter((item) => item.id !== delivery.itemId);
          }
          return items.map((item) => {
            if (item.id !== delivery.itemId) return item;
            if (delivery.status === "sending") {
              return {
                ...item,
                attachments: delivery.attachments ?? item.attachments,
                status: "sending",
                error: undefined,
              };
            }
            return {
              ...item,
              attachments: delivery.attachments ?? item.attachments,
              dispatchReservation: undefined,
              status: "failed",
              error: delivery.error ?? "Delivery was interrupted. Try again.",
            };
          });
        });
        if (delivery.status !== "sending") {
          forgetQueuedAttachmentFollowUpDelivery(delivery.queueKey, delivery.itemId);
        }
      }),
    [],
  );
  // Attachment preparation can finish out of Send order. A completed agent
  // run must not advance a materialized later row while an earlier accepted
  // Send is still preparing off-queue.
  const pendingAttachmentPreparationsRef = useRef<
    Record<string, Map<number, PendingAttachmentPreparation>>
  >({});
  const completedAgentRunAwaitingAttachmentPreparationRef = useRef(new Set<string>());
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
  // paths. The module-lifetime continuation coordinator below serializes those
  // sources and hands an unstarted callback to whichever Workspace is mounted.
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
  const workingReconcileMissesRef = useRef(new Map<string, WorkingReconcileMiss>());
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
  const [composerModelCommandPalette, setComposerModelCommandPalette] = useState(false);
  const [composerModelFlyout, setComposerModelFlyout] = useState<ModelPickerFlyout>(null);
  const [modelSearch, setModelSearch] = useState("");
  const composerModelTriggerRef = useRef<HTMLButtonElement>(null);
  const composerModelPopoverRef = useRef<HTMLDivElement>(null);
  const composerModelSearchRef = useRef<HTMLInputElement>(null);
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
  // Process identity is transport authority, distinct from the runtime or
  // stored session ids that survive resume. Capture it when a mode connects so
  // an accepted run can later prove that recovery crossed a process boundary.
  const connectedHermesRuntimeIncarnationsRef = useRef<Map<boolean, HermesRuntimeIncarnation>>(
    new Map(),
  );
  // The gateway's close listener is registered once per client instance, so
  // it routes through this ref to always run the latest render's recovery
  // closure (see recoverFromGatewayClose).
  const gatewayCloseHandlerRef = useRef((_fullMode: boolean) => {});
  // Per-mode: both gateways can drop together (network reconnect), and one
  // mode's in-flight recovery must not swallow the other's only onClose.
  const gatewayRecoveringRef = useRef<Set<boolean>>(new Set());
  // A replacement transport can itself close while session.resume is still
  // crossing the handoff barrier. Coalesce those closes into one follow-up
  // attempt after the current recovery releases its per-mode ownership.
  const gatewayRecoveryRetryRequestedRef = useRef<Set<boolean>>(new Set());
  // One live gateway subscription per Hermes session. A follow-up send while
  // the previous turn is still streaming must replace the old handler, not
  // stack a second one — otherwise every event lands twice in liveEvents.
  const sessionGatewayUnlistenRef = useRef<Map<string, () => void>>(new Map());
  // A replacement mount can overwrite the module route registry before this
  // mount's delayed gateway close runs. Retain the sources this mount registered
  // so that physical-close cleanup stays scoped to its Agent runs.
  const ownedAgentRunGatewayEventSourcesRef = useRef<Map<string, symbol>>(new Map());
  // Preserve client-close ordering before a replacement gateway resumes a
  // running session. This promise resolves when close() is issued; only the
  // patched session.resume ACK proves the server has atomically retired the
  // old transport's approval notifier generation.
  const ownedAgentRunGatewayPhysicalDetachesRef = useRef<Set<AgentRunGatewayPhysicalDetach>>(
    new Set(),
  );
  // Completion source identity spans reconnects for one Agent run, but async replay
  // checks belong to the listener that started them. A fresh epoch invalidates
  // proof work left behind by the listener recovery just replaced.
  const agentRunListenerEpochsRef = useRef<Map<string, symbol>>(new Map());
  // Listener replacement during reconnect must keep one Agent-run-level completion
  // identity so a replayed terminal cannot advance queued follow-ups twice.
  const agentRunCompletionSourcesRef = useRef<Map<string, symbol>>(
    new Map(Object.entries(continuity?.runCompletionSources ?? {})),
  );
  // Retain only the latest handled source for each session. Active-source
  // identity checks below reject callbacks older than that bounded history.
  const handledAgentRunCompletionSourcesRef = useRef<Map<string, symbol>>(new Map());
  const acceptedAgentRunCompletionSourcesRef = useRef<Set<symbol>>(new Set());
  // The retained stream spans multiple prompts. Record the revision at which
  // each current Agent run began so a failed message boundary from an older
  // Agent run cannot poison authoritative idle settlement for a later one.
  const agentRunStartRevisionsRef = useRef<Map<string, number>>(
    new Map(Object.entries(continuity?.runStartRevisions ?? {})),
  );
  // Current Agent run persistence proof is needed by every terminal authority path,
  // including polling and listeners replaced after reconnect/remount.
  const agentRunAuthorityProofsRef = useRef<Map<string, AgentRunAuthorityProof>>(
    new Map(Object.entries(continuity?.runAuthorityProofs ?? {})),
  );
  const pendingAgentRunTerminalEvidenceRef = useRef<Map<string, PendingAgentRunTerminalEvidence>>(
    pendingAgentRunTerminalEvidenceRegistry,
  );
  const pendingAgentRunAcceptanceRef = useRef<Map<string, PendingAgentRunAcceptance>>(
    pendingAgentRunAcceptanceRegistry,
  );
  const agentRunMonitorOwnersRef = useRef<Map<string, AgentRunMonitorOwner>>(
    agentRunMonitorOwnerRegistry,
  );
  const liveEventsRef = useRef<Record<string, HermesLiveStream>>(liveEvents);
  // Hermes does not always attach a replay-stable event id. Remember a bounded
  // history of accepted terminal shapes so an older no-id terminal replay can
  // be checked against runtime authority before it advances local queues.
  const agentRunTerminalFingerprintsRef = useRef<Map<string, string[]>>(
    new Map([
      ...Object.entries(continuity?.liveEvents ?? {}).flatMap(([sessionId, stream]) => {
        const fingerprints = hermesTerminalFingerprints(stream);
        return fingerprints.length > 0 ? [[sessionId, fingerprints] as const] : [];
      }),
      ...Object.entries(continuity?.terminalFingerprints ?? {}),
    ]),
  );
  const hydratedTaskIdsRef = useRef<Set<string>>(new Set());
  // Tasks whose hydration fetch has resolved (hydratedTaskIdsRef only says
  // the fetch *started*) — the scroll-settling logic needs the landing.
  const taskHistoryLoadedIdsRef = useRef<Set<string>>(new Set());
  const newSessionModeRef = useRef(newSessionMode);
  // sessionId -> the report captured for the active report turn. Once June's
  // diagnostic turn finishes, it moves to reviewableIssueReports so the user
  // can add context or send it.
  const pendingIssueReportsRef = useRef<Map<string, PendingIssueReport>>(
    restorePendingIssueReportRegistry(continuity?.pendingIssueReports),
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
  const deferredFailedIssueReportDeliverySessionIdsRef = useRef<Set<string>>(
    deferredFailedIssueReportDeliverySessionIdRegistry,
  );
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

  function setReviewableIssueReportLocally(sessionId: string, report: PendingIssueReport | null) {
    const next = { ...reviewableIssueReportsRef.current };
    if (report) {
      next[sessionId] = report;
    } else {
      delete next[sessionId];
    }
    reviewableIssueReportsRef.current = next;
    setReviewableIssueReports(next);
    return next;
  }

  function setReviewableIssueReport(sessionId: string, report: PendingIssueReport | null) {
    persistReviewableIssueReports(setReviewableIssueReportLocally(sessionId, report));
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

  function queueIssueReportDiagnosisRefresh(
    sessionId: string,
    delayMs = 300,
    transcriptPersistenceProof?: AgentRunTranscriptPersistenceProof,
  ) {
    let record = issueReportDiagnosisRefreshRegistry.get(sessionId);
    if (!record) {
      let resolveRefresh = () => {};
      const promise = new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
      const createdRecord: IssueReportDiagnosisRefreshRecord = {
        due: false,
        executionGeneration: 0,
        promise,
        resolve: resolveRefresh,
        settled: false,
        timer: 0,
        transcriptPersistenceProof,
      };
      createdRecord.timer = window.setTimeout(() => {
        createdRecord.due = true;
        executeDueIssueReportDiagnosisRefresh(createdRecord);
      }, delayMs);
      issueReportDiagnosisRefreshRegistry.set(sessionId, createdRecord);
      void promise.finally(() => {
        if (issueReportDiagnosisRefreshRegistry.get(sessionId) === createdRecord) {
          issueReportDiagnosisRefreshRegistry.delete(sessionId);
        }
      });
      record = createdRecord;
    }
    const owner = workspaceMountEpochRef.current;
    if (
      record.owner !== owner ||
      (transcriptPersistenceProof !== undefined &&
        record.transcriptPersistenceProof !== transcriptPersistenceProof)
    ) {
      record.executionGeneration += 1;
    }
    if (transcriptPersistenceProof) {
      record.transcriptPersistenceProof = transcriptPersistenceProof;
    }
    record.owner = owner;
    record.executor = async (proof) => {
      await refreshHermesSession(sessionId, proof);
    };
    executeDueIssueReportDiagnosisRefresh(record);
    const refresh = record.promise;
    if (issueReportDiagnosisRefreshesRef.current.get(sessionId) === refresh) {
      return refresh;
    }
    setIssueReportDiagnosisRefreshing(sessionId, true);
    issueReportDiagnosisRefreshesRef.current.set(sessionId, refresh);
    void refresh.finally(() => {
      if (issueReportDiagnosisRefreshesRef.current.get(sessionId) === refresh) {
        issueReportDiagnosisRefreshesRef.current.delete(sessionId);
        setIssueReportDiagnosisRefreshing(sessionId, false);
      }
    });
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
    if (!issueReport || acceptedPendingIssueReportRegistry.get(sessionId) !== issueReport) {
      return false;
    }
    clearPendingIssueReport(sessionId, issueReport);
    deferredFailedIssueReportDeliverySessionIdsRef.current.delete(sessionId);
    dispatchIssueReportPromoted({
      storedSessionId: sessionId,
      report: issueReport,
      queueDiagnosisRefresh: options.queueDiagnosisRefresh,
    });
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
    function mergePromotedIssueReport(detail: IssueReportPromotedDetail) {
      setReviewableIssueReportLocally(detail.storedSessionId, detail.report);
    }

    function onIssueReportPromoted(event: Event) {
      const detail = (event as CustomEvent<IssueReportPromotedDetail>).detail;
      if (!detail?.storedSessionId) return;
      mergePromotedIssueReport(detail);
      if (detail.queueDiagnosisRefresh) {
        queueIssueReportDiagnosisRefresh(detail.storedSessionId);
      } else {
        setIssueReportDiagnosisRefreshing(detail.storedSessionId, false);
      }
      if (issueReportPromotionRegistry.get(detail.storedSessionId) === detail) {
        issueReportPromotionRegistry.delete(detail.storedSessionId);
      }
    }

    function onIssueReportDeliverySettled(event: Event) {
      const detail = (event as CustomEvent<IssueReportDeliverySettledDetail>).detail;
      if (!detail?.storedSessionId) return;
      try {
        setIssueReportSubmitting(detail.storedSessionId, false);
        if (detail.result.sent) {
          deferredFailedIssueReportDeliverySessionIdsRef.current.delete(detail.storedSessionId);
          if (reviewableIssueReportsRef.current[detail.storedSessionId] === detail.report) {
            setReviewableIssueReportLocally(detail.storedSessionId, null);
          }
          return;
        }
        if (pendingIssueReportsRef.current.has(detail.storedSessionId)) {
          deferredFailedIssueReportDeliverySessionIdsRef.current.add(detail.storedSessionId);
        } else if (!reviewableIssueReportsRef.current[detail.storedSessionId]) {
          setReviewableIssueReportLocally(detail.storedSessionId, detail.report);
        }
        setError(detail.result.errorMessage, { sessionId: detail.storedSessionId });
      } finally {
        forgetIssueReportUiTransition("delivery-settled", detail);
      }
    }

    function onIssueReportFollowUpSubmitFailed(event: Event) {
      const detail = (event as CustomEvent<IssueReportFollowUpSubmitFailedDetail>).detail;
      if (!detail?.storedSessionId) return;
      try {
        clearPendingIssueReport(detail.storedSessionId, detail.queuedReport);
        if (detail.restoreReport && !reviewableIssueReportsRef.current[detail.storedSessionId]) {
          setReviewableIssueReportLocally(detail.storedSessionId, detail.restoreReport);
        }
      } finally {
        forgetIssueReportUiTransition("follow-up-submit-failed", detail);
      }
    }

    window.addEventListener(ISSUE_REPORT_PROMOTED_EVENT, onIssueReportPromoted);
    window.addEventListener(ISSUE_REPORT_DELIVERY_SETTLED_EVENT, onIssueReportDeliverySettled);
    window.addEventListener(
      ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT,
      onIssueReportFollowUpSubmitFailed,
    );
    // Promotion can happen after state initialization but before this passive
    // effect subscribes. Subscribe first, then consume the app-lifetime record
    // and merge persisted state so that narrow handoff cannot lose the report.
    for (const detail of issueReportPromotionRegistry.values()) {
      onIssueReportPromoted(
        new CustomEvent<IssueReportPromotedDetail>(ISSUE_REPORT_PROMOTED_EVENT, { detail }),
      );
    }
    for (const transition of [...issueReportUiTransitionRegistry]) {
      if (transition.kind === "delivery-settled") {
        onIssueReportDeliverySettled(
          new CustomEvent<IssueReportDeliverySettledDetail>(ISSUE_REPORT_DELIVERY_SETTLED_EVENT, {
            detail: transition.detail,
          }),
        );
      } else {
        onIssueReportFollowUpSubmitFailed(
          new CustomEvent<IssueReportFollowUpSubmitFailedDetail>(
            ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT,
            { detail: transition.detail },
          ),
        );
      }
    }
    const persistedReports = persistedReviewableIssueReports();
    if (Object.keys(persistedReports).length > 0) {
      const next = { ...reviewableIssueReportsRef.current, ...persistedReports };
      reviewableIssueReportsRef.current = next;
      setReviewableIssueReports(next);
    }
    return () => {
      window.removeEventListener(ISSUE_REPORT_PROMOTED_EVENT, onIssueReportPromoted);
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
      void stopComputerUseRuns().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    const releaseSupersededComputerUseRun = (event: Event) => {
      const detail = (event as CustomEvent<AgentRunStartedDetail>).detail;
      if (!detail?.storedSessionId || detail.runMonitorGeneration === undefined) return;
      // Ignore stale announcements and this Workspace's own accepted
      // generation. Only another surface taking newer ownership may revoke the
      // visible turn's attended lease. These comparisons stay correct whether
      // this listener runs before or after the app-lifetime run observer.
      const latestGeneration = latestAgentRunGenerationRegistry.get(detail.storedSessionId);
      const localGeneration = agentRunMonitorOwnersRef.current.get(
        detail.storedSessionId,
      )?.generation;
      if (
        (latestGeneration !== undefined && detail.runMonitorGeneration < latestGeneration) ||
        (localGeneration !== undefined && detail.runMonitorGeneration <= localGeneration)
      ) {
        return;
      }
      void releaseComputerUseRunsForSession(detail.storedSessionId).catch(() => undefined);
    };
    window.addEventListener(AGENT_RUN_STARTED_EVENT, releaseSupersededComputerUseRun);
    return () => {
      window.removeEventListener(AGENT_RUN_STARTED_EVENT, releaseSupersededComputerUseRun);
    };
  }, []);

  useEffect(() => {
    // The activity projection is UI state and may lag a navigation cleanup by
    // one React commit. Completion-source continuity is the stronger signal
    // that a live semantic route still needs to be reclaimed.
    const restoredStoredSessionIds = Array.from(
      new Set([
        ...workingSessionIdsRef.current,
        ...Object.keys(continuity?.runCompletionSources ?? {}),
      ]),
    );
    if (!restoredStoredSessionIds.length) return;
    let cancelled = false;
    const resumeHandoffs = new Map(
      restoredStoredSessionIds.map((storedSessionId) => [
        storedSessionId,
        reserveHermesSessionTransportHandoff(storedSessionId),
      ]),
    );

    void (async () => {
      for (const storedSessionId of restoredStoredSessionIds) {
        // A navigation can race the React state commit that remembers the
        // ephemeral runtime session id. Resume itself is keyed by the durable
        // stored session id, and the handoff listener stages before its ingress
        // gate, so the stored session id is a safe provisional value until the
        // ACK rebinds it.
        const runtimeSessionId = runtimeSessionIdsRef.current[storedSessionId] ?? storedSessionId;
        const priorPhysicalDetach = agentRunGatewayPhysicalDetachRegistry.get(storedSessionId);
        const resumeHandoff = resumeHandoffs.get(storedSessionId);
        if (!resumeHandoff) continue;
        let restoredListener: ReturnType<typeof attachHermesSessionEventListener> | undefined;
        try {
          const gateway = await ensureHermesGateway(sessionUnrestricted(storedSessionId), {
            refreshBridgeStatus: true,
          });
          if (cancelled) {
            resumeHandoff.cancel();
            continue;
          }
          // Reconnect only to observe the existing run. A process restored
          // after an app relaunch did not cross this mount's visible Send
          // boundary, so it must not receive a fresh Computer use lease.
          restoredListener = attachHermesSessionEventListener({
            gateway,
            runAlreadyAccepted: true,
            runtimeSessionId,
            sessionDisplayTitle:
              hermesSessionItemsRef.current.find((session) => session.id === storedSessionId)
                ?.title ?? "Agent session",
            stageEventsUntilResume: true,
            storedSessionId,
          });
          const activeRestoredListener = restoredListener;
          const restoredCompletionSource = activeRestoredListener.completionSource;
          await trackInFlightSessionDispatch(
            resumeHandoff.run(async () => {
              // Preserve client-side close ordering before asking the pinned
              // runtime to transfer the live session. The close promise alone
              // cannot prove server cleanup; the patched session.resume ACK is
              // the barrier that deactivates and drains the old approval
              // notifier generation before this route becomes actionable.
              await priorPhysicalDetach?.detached;
              if (
                cancelled ||
                agentRunCompletionSourcesRef.current.get(storedSessionId) !==
                  restoredCompletionSource ||
                handledAgentRunCompletionSourcesRef.current.get(storedSessionId) ===
                  restoredCompletionSource
              ) {
                activeRestoredListener.abortResumeHandoff();
                return;
              }
              const resumed = await gateway.request<HermesRuntimeSessionResponse>(
                "session.resume",
                {
                  session_id: storedSessionId,
                  cols: 96,
                },
              );
              const resumedRuntimeSessionId = resumed.session_id;
              if (
                !resumedRuntimeSessionId ||
                cancelled ||
                agentRunCompletionSourcesRef.current.get(storedSessionId) !==
                  restoredCompletionSource ||
                handledAgentRunCompletionSourcesRef.current.get(storedSessionId) ===
                  restoredCompletionSource
              ) {
                activeRestoredListener.abortResumeHandoff();
                return;
              }
              activeRestoredListener.rebindRuntimeSessionId(resumedRuntimeSessionId);
              reconcileHermesRuntimeReplacementAfterResume(
                storedSessionId,
                resumed,
                connectedHermesRuntimeIncarnationsRef.current.get(
                  sessionUnrestricted(storedSessionId),
                ),
              );
              recordHermesResumePersistenceBoundary(
                storedSessionId,
                resumed.messages,
                resumed.pending_message_complete,
              );
              // Retire only a process-replacement-proven open transcript before
              // staged replacement frames can affect the live stream. Replay
              // those frames next, then fill only a missing in-flight suffix.
              activeRestoredListener.completeResumeHandoff(resumed.retired_approval_request_ids);
              const inflightAssistant = resumed.inflight?.assistant;
              if (typeof inflightAssistant === "string" && inflightAssistant.length > 0) {
                activeRestoredListener.reconcileResumeSnapshot(
                  inflightAssistant,
                  resumed.running !== false && resumed.inflight?.streaming !== false,
                );
              }
              runtimeSessionIdsRef.current = {
                ...runtimeSessionIdsRef.current,
                [storedSessionId]: resumedRuntimeSessionId,
              };
              setRuntimeSessionIds((current) => {
                return {
                  ...current,
                  [storedSessionId]: resumedRuntimeSessionId,
                };
              });
              if (Array.isArray(resumed.messages) || resumed.running === false) {
                void refreshHermesSession(storedSessionId);
              }
            }),
          );
        } catch {
          resumeHandoff.cancel();
          // The working-session poll still reconciles if reconnecting fails.
          restoredListener?.abortResumeHandoff();
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const handoff of resumeHandoffs.values()) handoff.cancel();
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
    const completionSource = agentRunCompletionSourcesRef.current.get(sessionId);
    if (completionSource) {
      acceptedAgentRunCompletionSourcesRef.current.delete(completionSource);
    }
    agentRunCompletionSourcesRef.current.delete(sessionId);
    handledAgentRunCompletionSourcesRef.current.delete(sessionId);
    workingReconcileMissesRef.current.delete(sessionId);
    agentRunStartRevisionsRef.current.delete(sessionId);
    agentRunAuthorityProofsRef.current.delete(sessionId);
    const pendingAcceptance = pendingAgentRunAcceptanceRef.current.get(sessionId);
    const unacceptedUserMessageId = pendingAcceptance?.authorityProof.submittedUserMessage.id;
    if (unacceptedUserMessageId) {
      setPendingHermesMessages((current) => {
        const next = {
          ...current,
          [sessionId]: (current[sessionId] ?? []).filter(
            (message) => message.id !== unacceptedUserMessageId,
          ),
        };
        pendingHermesMessagesRef.current = next;
        return next;
      });
    }
    pendingAgentRunAcceptanceRef.current.delete(sessionId);
    pendingAgentRunTerminalEvidenceRef.current.delete(sessionId);
    agentRunMonitorOwnersRef.current.delete(sessionId);
    clearPendingIssueReport(sessionId);
    deferredFailedIssueReportDeliverySessionIdRegistry.delete(sessionId);
    forgetLatestAgentRunGeneration(sessionId);
    agentRunMonitorTerminalRegistry.delete(sessionId);
    agentRunTerminalFingerprintsRef.current.delete(sessionId);
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
        if (composerModelCommandPalette) {
          setComposerModelOpen(false);
          composerEditorRef.current?.focus();
          return;
        }
        // Escape peels one layer at a time: the all-models panel first,
        // then the popover itself.
        if (composerModelFlyout?.kind === "all") {
          setComposerModelFlyout(null);
          setModelSearch("");
        } else {
          setComposerModelOpen(false);
        }
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [composerModelCommandPalette, composerModelOpen, composerModelFlyout]);

  useLayoutEffect(() => {
    if (composerModelOpen && (composerModelCommandPalette || composerModelFlyout?.kind === "all")) {
      composerModelSearchRef.current?.focus();
    }
  }, [composerModelCommandPalette, composerModelFlyout, composerModelOpen]);

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
      if (composerModelCommandPalette) {
        const composerBox = form.querySelector<HTMLElement>(".agent-composer-box");
        const composerRect = composerBox?.getBoundingClientRect() ?? formRect;
        popover.style.left = `${composerRect.left - formRect.left}px`;
        popover.style.right = `${formRect.right - composerRect.right}px`;
        popover.style.bottom = `${formRect.bottom - composerRect.top + 4}px`;
        popover.style.setProperty(
          "--model-command-available-height",
          `${Math.max(96, composerRect.top - 12)}px`,
        );
        return;
      }
      popover.style.left = "";
      popover.style.removeProperty("--model-command-available-height");
      popover.style.right = `${formRect.right - triggerRect.right}px`;
      popover.style.bottom = `${formRect.bottom - triggerRect.top + 4}px`;
    }
    positionPopover();
    window.addEventListener("resize", positionPopover);
    return () => window.removeEventListener("resize", positionPopover);
  }, [composerModelCommandPalette, composerModelOpen]);

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
  function openComposerModelPicker(commandPalette = false) {
    setModelSearch("");
    setComposerModelFlyout(null);
    setComposerModelCommandPalette(commandPalette);
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
    const throughRevision = liveEventsRef.current[selectedHermesSessionId]?.revision ?? 0;
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
        reconcilePersistedHermesLiveEvents(selectedHermesSessionId, messages, throughRevision);
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
    const mountEpoch = workspaceMountEpochRef.current;
    // This mount owns the snapshot now — consume it so it can't hydrate a
    // second mount (error-boundary remount, overlapping test renders) with
    // data this mount is about to mutate. Consumed here rather than in the
    // continuity initializer because StrictMode double-invokes lazy
    // initializers, which must stay pure; the unmount capture below writes
    // a fresh snapshot either way.
    sessionContinuity = null;
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
      // This unmounted component is no longer the semantic consumer. Keep
      // origin transports alive for in-flight RPCs, but queue their frames
      // until a mounted route takes ownership.
      suspendAgentRunGatewayEventRoutesForMount(mountEpoch);
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
        const monitorOwner = agentRunMonitorOwnersRef.current.get(sessionId);
        if (!hasAutomaticContinuation(sessionId) && monitorOwner) {
          releaseAgentRunSettlement(sessionId, monitorOwner.generation);
        }
      }
      const consentRequest = imageSafeModeConsentRequestRef.current;
      imageSafeModeConsentRequestRef.current = null;
      consentRequest?.resolve({ action: "dismiss" });
      // Explicit gateway close suppresses the unexpected-close callback, but
      // the runtime still drains approvals fail-closed when the socket drops.
      // Mirror that boundary before capturing continuity so the next mount
      // cannot restore an actionable card for a request Hermes already denied.
      retireApprovalsForGatewayDetach({ publishMountedState: false });
      // Keep any mid-run session alive for the next mount before the
      // gateways (and with them the live event streams) go away.
      sessionContinuity = captureSessionContinuity({
        sessionItems: hermesSessionItemsRef.current,
        pendingMessages: pendingHermesMessagesRef.current,
        runtimeSessionIds: runtimeSessionIdsRef.current,
        liveEvents: liveEventsRef.current,
        runStartRevisions: Object.fromEntries(agentRunStartRevisionsRef.current),
        runAuthorityProofs: Object.fromEntries(agentRunAuthorityProofsRef.current),
        runCompletionSources: Object.fromEntries(agentRunCompletionSourcesRef.current),
        terminalFingerprints: Object.fromEntries(agentRunTerminalFingerprintsRef.current),
        titleOverrides: sessionTitleOverridesRef.current,
        titleSources: sessionTitleSourceRef.current,
        pendingIssueReports: Object.fromEntries(pendingIssueReportsRef.current),
        reviewableIssueReports: reviewableIssueReportsRef.current,
        diagnosisRefreshIssueReportSessionIds: diagnosisRefreshIssueReportSessionIdsRef.current,
        submittingIssueReportSessionIds: submittingIssueReportSessionIdsRef.current,
        queuedAttachmentFollowUps: queuedAttachmentFollowUpsRef.current,
      });
      const ownedDeliveries = [...completedAgentRunContinuationRegistry.values()].filter(
        (continuation) => continuation.phase === "delivering" && continuation.owner === mountEpoch,
      );
      const inFlightSessionDispatches = [...inFlightSessionDispatchesRef.current];
      inFlightSessionDispatchesRef.current.clear();
      const gatewayCloseBarriers = [
        ...inFlightSessionDispatches,
        ...ownedDeliveries.map((continuation) => continuation.deliverySettled ?? Promise.resolve()),
      ];
      const closeOwnedGateways = () => {
        // An origin transport can receive an approval after unmount while an
        // in-flight prompt keeps its socket alive. Fail that request closed at
        // the actual detach boundary, scoped to the run source this mount
        // owned, so neither handoff replay nor a replacement route can revive it.
        try {
          retireAgentRunGatewayApprovalsAtPhysicalClose(
            ownedAgentRunGatewayEventSourcesRef.current,
          );
          for (const gateway of new Set(gatewaysRef.current.values())) gateway.close();
          retireAgentRunGatewayEventRoutesForMount(mountEpoch);
        } finally {
          for (const detach of ownedAgentRunGatewayPhysicalDetachesRef.current) {
            detach.resolve();
            if (agentRunGatewayPhysicalDetachRegistry.get(detach.storedSessionId) === detach) {
              agentRunGatewayPhysicalDetachRegistry.delete(detach.storedSessionId);
            }
          }
          ownedAgentRunGatewayPhysicalDetachesRef.current.clear();
        }
      };
      if (gatewayCloseBarriers.length > 0) {
        // Keep the JSON-RPC socket alive until every already-started dispatch
        // settles. Closing it during resume can strand the FIFO until timeout;
        // closing it during prompt.submit makes acceptance unknowable and can
        // manufacture a Retry.
        void Promise.all(gatewayCloseBarriers).finally(closeOwnedGateways);
      } else {
        closeOwnedGateways();
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

  const runMonitorTerminalHandlerRef = useRef<(detail: AgentSessionStatusDetail) => void>(() => {});
  runMonitorTerminalHandlerRef.current = (detail) => {
    const sessionId = detail?.sessionId;
    if (
      !sessionId ||
      detail.runMonitorGeneration === undefined ||
      (detail.status !== "failed" && detail.status !== "cancelled")
    ) {
      return;
    }
    const monitorOwner = agentRunMonitorOwnersRef.current.get(sessionId);
    const latestGeneration = latestAgentRunGenerationRegistry.get(sessionId);
    const ownsLocalGeneration = monitorOwner?.generation === detail.runMonitorGeneration;
    if (!ownsLocalGeneration && latestGeneration !== detail.runMonitorGeneration) return;
    const currentAuthorityProof = agentRunAuthorityProofsRef.current.get(sessionId);
    if (
      monitorOwner &&
      currentAuthorityProof &&
      currentAuthorityProof !== monitorOwner.authorityProof &&
      detail.runMonitorGeneration <= monitorOwner.generation
    ) {
      return;
    }
    const completionSource = ownsLocalGeneration
      ? agentRunCompletionSourcesRef.current.get(sessionId)
      : undefined;
    sessionGatewayUnlistenRef.current.get(sessionId)?.();
    if (completionSource) {
      handledAgentRunCompletionSourcesRef.current.set(sessionId, completionSource);
      acceptedAgentRunCompletionSourcesRef.current.delete(completionSource);
    }
    agentRunCompletionSourcesRef.current.delete(sessionId);
    agentRunStartRevisionsRef.current.delete(sessionId);
    agentRunAuthorityProofsRef.current.delete(sessionId);
    pendingAgentRunAcceptanceRef.current.delete(sessionId);
    pendingAgentRunTerminalEvidenceRef.current.delete(sessionId);
    if (monitorOwner && monitorOwner.generation <= detail.runMonitorGeneration) {
      agentRunMonitorOwnersRef.current.delete(sessionId);
    }
    workingReconcileMissesRef.current.delete(sessionId);
    pendingActionStore.resolveSession(sessionId);
    void releaseComputerUseRunsForSession(sessionId).catch(() => undefined);
    clearSubmittedSteers(sessionId);
    if (!ownsLocalGeneration) {
      if (detail.status === "cancelled") clearSessionActivity(sessionId, "cancelled");
    } else if (detail.status === "failed") {
      const summary = detail.summary?.trim() || "June hit a problem.";
      recordSessionErrorActivity(sessionId, summary);
      setError(summary, { sessionId });
    } else {
      clearSessionActivity(sessionId, "cancelled");
    }
    promotePendingIssueReportToReview(sessionId, { queueDiagnosisRefresh: true });
    window.setTimeout(() => {
      void refreshHermesSession(sessionId);
    }, 300);
    retireAgentRunMonitorTerminal(sessionId, detail.runMonitorGeneration);
  };
  const runMonitorSettledHandlerRef = useRef<(detail: AgentRunSettledDetail) => void>(() => {});
  runMonitorSettledHandlerRef.current = (detail) => {
    const sessionId = detail?.sessionId;
    if (!sessionId) return;
    const monitorOwner = agentRunMonitorOwnersRef.current.get(sessionId);
    const latestGeneration = latestAgentRunGenerationRegistry.get(sessionId);
    const ownsLocalGeneration = monitorOwner?.generation === detail.runMonitorGeneration;
    if (!ownsLocalGeneration && latestGeneration !== detail.runMonitorGeneration) return;
    const currentAuthorityProof = agentRunAuthorityProofsRef.current.get(sessionId);
    if (
      monitorOwner &&
      currentAuthorityProof &&
      currentAuthorityProof !== monitorOwner.authorityProof &&
      detail.runMonitorGeneration <= monitorOwner.generation
    ) {
      return;
    }
    if (monitorOwner && monitorOwner.generation <= detail.runMonitorGeneration) {
      agentRunMonitorOwnersRef.current.delete(sessionId);
    }
    const completionSource = ownsLocalGeneration
      ? agentRunCompletionSourcesRef.current.get(sessionId)
      : undefined;
    sessionGatewayUnlistenRef.current.get(sessionId)?.();
    if (completionSource) {
      handledAgentRunCompletionSourcesRef.current.set(sessionId, completionSource);
      acceptedAgentRunCompletionSourcesRef.current.delete(completionSource);
    }
    agentRunCompletionSourcesRef.current.delete(sessionId);
    agentRunStartRevisionsRef.current.delete(sessionId);
    agentRunAuthorityProofsRef.current.delete(sessionId);
    pendingAgentRunAcceptanceRef.current.delete(sessionId);
    pendingAgentRunTerminalEvidenceRef.current.delete(sessionId);
    workingReconcileMissesRef.current.delete(sessionId);
    pendingActionStore.resolveSession(sessionId);
    void releaseComputerUseRunsForSession(sessionId).catch(() => undefined);
    promotePendingIssueReportToReview(sessionId, { queueDiagnosisRefresh: true });
    const activityCounts = clearSessionActivity(sessionId);
    if (ownsLocalGeneration) {
      dispatchAgentSessionStatus({
        sessionId,
        title: detail.title,
        status: "completed",
        summary: detail.summary,
        ...activityCounts,
      });
    }
    // A passive completion has no local gateway source, but it still needs a
    // distinct token when another generation's continuation callback is in
    // flight. Otherwise that callback can retire after this event and strand
    // the durable follow-up queue.
    continueAfterCompletedAgentRun(
      sessionId,
      completionSource ?? Symbol("passive Agent run completion"),
    );
    window.setTimeout(() => {
      void refreshHermesSession(sessionId);
    }, 300);
    retireAgentRunMonitorTerminal(sessionId, detail.runMonitorGeneration);
  };
  useEffect(
    () =>
      subscribeAgentRunMonitorTerminals((record) => {
        if (record.kind === "status") {
          runMonitorTerminalHandlerRef.current(record.detail);
        } else {
          runMonitorSettledHandlerRef.current(record.detail);
        }
      }),
    [],
  );

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

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const message = draft.trim();
    if (
      (!message && !attachments.length) ||
      submitting ||
      importingFiles ||
      textActionsDisabledReason ||
      selectedHermesSessionIsProvisional ||
      imageSlashBlockedByModel
    )
      return;
    // This is the user-visible Send boundary. Skill expansion, file reads,
    // title generation, and session resume can all await; a picker change
    // during any of them belongs to the following run.
    const sentModelTarget = captureSessionModelTarget();
    const sentRunGenerationFence = sentModelTarget.targetStoredSessionId
      ? {
          storedSessionId: sentModelTarget.targetStoredSessionId,
          generation: latestAgentRunGenerationRegistry.get(sentModelTarget.targetStoredSessionId),
        }
      : undefined;
    const sentDispatchOrder = ++composerDispatchOrderRef.current;
    const sentDispatchReservation = sentModelTarget.targetStoredSessionId
      ? reserveComposerDispatch(sentModelTarget.targetStoredSessionId)
      : undefined;
    const sentStartedNewSession = sentModelTarget.targetStoredSessionId === null;
    // prompt.submit prepends the injected `[June project context]` block for a
    // project-filed session (see prepareProjectPrompt at the dispatch site), so
    // the size guard must estimate that same larger text — otherwise a project
    // with long instructions can slip a near-limit prompt past the warning and
    // fail only after submit. Mirror the dispatch: ambient project context plus
    // this send's last delivered signature, so the block counts exactly when it
    // will actually be injected and dedup-skipped turns aren't over-warned.
    // (The steer path never calls prompt.submit, so it estimates the raw text.)
    const sizeEstimateContent = (baseContent: string, targetSessionId?: string): string => {
      const previousSignature =
        !newSessionModeRef.current && targetSessionId
          ? projectContextSignaturesBySessionId.get(targetSessionId)
          : undefined;
      return prepareProjectPrompt(baseContent, projectContext, previousSignature).text;
    };
    if (message) {
      try {
        const handledBuiltinCommand = await handleBuiltinComposerSlashCommand(
          message,
          sentModelTarget,
          sentDispatchReservation,
        );
        if (composerDispatchWasInvalidated(sentDispatchReservation)) return;
        if (handledBuiltinCommand) {
          cancelComposerDispatch(sentDispatchReservation);
          return;
        }
      } catch (err) {
        cancelComposerDispatch(sentDispatchReservation);
        throw err;
      }
    }
    const attachmentQueueSessionId =
      attachments.length > 0 &&
      !category &&
      !newSessionModeRef.current &&
      selectedHermesSessionId &&
      workingSessionIdsRef.current.has(selectedHermesSessionId)
        ? selectedHermesSessionId
        : undefined;
    if (attachmentQueueSessionId) {
      const attachmentPreparation = beginAttachmentPreparation(
        attachmentQueueSessionId,
        sentDispatchOrder,
        sentDispatchReservation,
      );
      let prepared: PreparedComposerSubmission;
      try {
        prepared = await prepareComposerSubmission(message, attachments);
      } catch (err) {
        if (attachmentPreparation.cancelled) {
          finishAttachmentPreparation(attachmentQueueSessionId, attachmentPreparation);
          return;
        }
        // The draft and attachments are still in the composer - only the
        // banner is needed for recovery, unlike the full submit path below.
        cancelComposerDispatch(sentDispatchReservation);
        finishAttachmentPreparation(attachmentQueueSessionId, attachmentPreparation);
        setError(messageFromError(err));
        return;
      }
      if (attachmentPreparation.cancelled) {
        finishAttachmentPreparation(attachmentQueueSessionId, attachmentPreparation);
        return;
      }
      const sizeWarning = oversizedComposerInputWarning({
        content: sizeEstimateContent(prepared.runtimeContent, attachmentQueueSessionId),
        inputSignature: composerInputSignature,
        attachments,
        model: generationModel,
        models: generationModels,
      });
      if (sizeWarning && composerSizeProceedSignatureRef.current !== sizeWarning.signature) {
        cancelComposerDispatch(sentDispatchReservation);
        finishAttachmentPreparation(attachmentQueueSessionId, attachmentPreparation);
        setComposerSizeWarning(sizeWarning);
        composerEditorRef.current?.focus();
        return;
      }
      enqueueAttachmentFollowUp(
        attachmentQueueSessionId,
        prepared,
        attachments,
        sentModelTarget,
        sentDispatchReservation,
        sentDispatchOrder,
      );
      forgetComposerDispatch(sentDispatchReservation);
      finishAttachmentPreparation(attachmentQueueSessionId, attachmentPreparation);
      clearComposerDraft();
      composerEditorRef.current?.focus();
      return;
    }
    // June is mid-run: send the message straight into the loop via steer so
    // June picks it up after the current tool call (adds context without
    // interrupting — Escape or Stop interrupts instead). Plain-text follow-ups
    // to an existing session only; attachments, reports, and new-session sends
    // take the full submit path below.
    if (
      message &&
      !attachments.length &&
      !category &&
      !newSessionModeRef.current &&
      selectedHermesSessionId &&
      workingSessionIdsRef.current.has(selectedHermesSessionId)
    ) {
      const steerSizeWarning = oversizedComposerInputWarning({
        content: message,
        inputSignature: composerInputSignature,
        attachments: [],
        model: generationModel,
        models: generationModels,
      });
      if (
        steerSizeWarning &&
        composerSizeProceedSignatureRef.current !== steerSizeWarning.signature
      ) {
        cancelComposerDispatch(sentDispatchReservation);
        setComposerSizeWarning(steerSizeWarning);
        composerEditorRef.current?.focus();
        return;
      }
      const steerSessionId = selectedHermesSessionId;
      // Delivery guarantee. Hermes only injects a steer into the next tool
      // result and rejects the RPC during a no-tool phase, so the steer alone
      // is unreliable. Record the text, attempt the steer (best effort — a
      // success a tool later drains is the mid-run path), and on the turn's
      // clean completion resend anything still pending as a follow-up.
      // `registered` tracks whether Hermes accepted the steer, so a
      // tool.complete only clears ones a tool could actually have drained.
      steerCardSeqRef.current += 1;
      const cardId = `steer-${steerCardSeqRef.current}`;
      const steerEntry: PendingSteer = {
        text: message,
        accepted: false,
        toolDrained: false,
        modelTarget: sentModelTarget,
        dispatchReservation: sentDispatchReservation,
        dispatchOrder: sentDispatchOrder,
      };
      forgetComposerDispatch(sentDispatchReservation);
      pendingSteerBySessionIdRef.current = {
        ...pendingSteerBySessionIdRef.current,
        [steerSessionId]: [
          ...(pendingSteerBySessionIdRef.current[steerSessionId] ?? []),
          steerEntry,
        ],
      };
      // Tack the submitted instruction onto the composer as a read-only card.
      // This is the sole in-flight representation (steerActiveSession no longer
      // writes a transcript line); it clears when the turn drains or ends.
      setSteerCardsBySessionId((prev) => ({
        ...prev,
        [steerSessionId]: [...(prev[steerSessionId] ?? []), { id: cardId, text: message }],
      }));
      void steerActiveSession(steerSessionId, message)
        .then(() => {
          steerEntry.accepted = true;
        })
        .catch((err: unknown) => {
          // A rejected steer (common during a no-tool phase) is not fatal — the
          // completion fallback still delivers it. Don't alarm the user.
          if (import.meta.env.DEV) {
            // biome-ignore lint/suspicious/noConsole: dev-only steer-rejection diagnostic
            console.debug("[steer] rejected; will deliver as follow-up", err);
          }
        });
      clearComposerDraft();
      composerEditorRef.current?.focus();
      return;
    }
    // The composer's category chip makes this a report: wrap the prompt to
    // frame it for the team and queue the delivery. Captured before the
    // composer clears so a failed send can restore the chip on retry.
    const reportCategory = category;
    const reportFollowUpSessionId =
      !reportCategory && !newSessionModeRef.current && selectedHermesSessionId
        ? selectedHermesSessionId
        : null;
    const reportFollowUp = reportFollowUpSessionId
      ? reviewableIssueReportsRef.current[reportFollowUpSessionId]
      : undefined;
    const submittedDraftKey = composerDraftKeyRef.current;
    // A hero submit plays the teardown transition: greeting up, suggestions
    // down during the session-create latency. Without it they sit frozen
    // through the wait and then vanish in a single frame when the
    // conversation takes over.
    if (heroMode) setHeroLeaving(true);
    setSubmittingHermesSessionId(
      newSessionModeRef.current ? null : (selectedHermesSessionId ?? null),
    );
    setSubmitting(true);
    let clearedDraft = false;
    let clearedAttachments = false;
    let submittedAttachments = attachments;
    let preparedForRecovery: PreparedComposerSubmission | undefined;
    let clearedIssueReportReview:
      | {
          sessionId: string;
          report: PendingIssueReport;
          queuedReport?: PendingIssueReport;
          deliveryWasSubmitting: boolean;
        }
      | undefined;
    try {
      const prepared = await prepareComposerSubmission(message, attachments);
      if (composerDispatchWasInvalidated(sentDispatchReservation)) return;
      const runtimeContent = reportCategory
        ? categoryPrompt(reportCategory, prepared.runtimeContent)
        : prepared.runtimeContent;
      preparedForRecovery = { ...prepared, runtimeContent };
      const sizeWarning = oversizedComposerInputWarning({
        content: sizeEstimateContent(runtimeContent, selectedHermesSessionId ?? undefined),
        inputSignature: composerInputSignature,
        attachments,
        model: generationModel,
        models: generationModels,
      });
      if (sizeWarning && composerSizeProceedSignatureRef.current !== sizeWarning.signature) {
        setComposerSizeWarning(sizeWarning);
        composerEditorRef.current?.focus();
        return;
      }
      const nextIssueReport: PendingIssueReport | undefined = reportCategory
        ? {
            category: reportCategory,
            // An attachments-only send has no typed text, but the server
            // requires a description; the report must not bounce there.
            description: prepared.typedMessage || ISSUE_REPORT_ATTACHMENTS_ONLY_DESCRIPTION,
            followUps: [],
            attachmentNames: attachments.map((attachment) => attachment.name),
            attachmentPaths: attachments.map((attachment) => attachment.path),
          }
        : reportFollowUp
          ? appendIssueReportFollowUp(
              reportFollowUp,
              prepared.typedMessage,
              attachments.map((attachment) => attachment.name),
              attachments.map((attachment) => attachment.path),
            )
          : undefined;
      if (draftRef.current.trim() === message && categoryRef.current === reportCategory) {
        composerEditorRef.current?.clear();
        setDraft("");
        setCategory(null);
        draftRef.current = "";
        categoryRef.current = null;
        forgetComposerDraft(submittedDraftKey);
        clearedDraft = true;
      }
      if (sameAgentAttachments(attachmentsRef.current, attachments)) {
        setComposerAttachments([]);
        clearedAttachments = true;
      }
      if (reportFollowUpSessionId && reportFollowUp) {
        setReviewableIssueReport(reportFollowUpSessionId, null);
        clearedIssueReportReview = {
          sessionId: reportFollowUpSessionId,
          report: reportFollowUp,
          queuedReport: nextIssueReport,
          deliveryWasSubmitting:
            submittingIssueReportSessionIdsRef.current.has(reportFollowUpSessionId),
        };
      }
      await submitHermesSession(runtimeContent, undefined, {
        displayContent: prepared.displayContent,
        titleContent: prepared.titleContent,
        attachments,
        modelTarget: sentModelTarget,
        runGenerationFence: sentRunGenerationFence,
        dispatchReservation: sentDispatchReservation,
        onAttachmentsUpdated: (nextAttachments) => {
          submittedAttachments = nextAttachments;
        },
        ...(nextIssueReport ? { issueReport: nextIssueReport } : {}),
      });
      if (composerDispatchWasInvalidated(sentDispatchReservation)) return;
      if (reportFollowUpSessionId) {
        deferredFailedIssueReportDeliverySessionIdsRef.current.delete(reportFollowUpSessionId);
      }
      setError(null);
      toast.dismiss(SESSION_BUSY_TOAST_ID);
    } catch (err) {
      if (composerDispatchWasInvalidated(sentDispatchReservation)) return;
      const errorMessage = messageFromError(err);
      const composerHasNewInput = Boolean(
        !(composerEditorRef.current?.isEmpty() ?? true) ||
          draftRef.current.trim() ||
          categoryRef.current ||
          attachmentsRef.current.length,
      );
      let recoveredInFollowUpQueue = false;
      // Restore the composer so a failed send doesn't eat the message, its
      // category chip, or its attachments. A model switch can wait for Hermes
      // to become idle, so the user may already be writing the next draft when
      // it eventually fails. Keep that newer input untouched and retain the
      // failed submission as an explicit, retryable Up next item instead.
      if (clearedDraft) {
        const retainedStoredSessionId = sentModelTarget.targetStoredSessionId;
        const failedQueueKey = sentStartedNewSession
          ? retainedStoredSessionId &&
            !newSessionModeRef.current &&
            selectedHermesSessionIdRef.current === retainedStoredSessionId
            ? retainedStoredSessionId
            : NEW_SESSION_RECOVERY_QUEUE_KEY
          : retainedStoredSessionId;
        if (
          composerHasNewInput &&
          failedQueueKey &&
          preparedForRecovery &&
          !reportCategory &&
          !clearedIssueReportReview
        ) {
          enqueueFailedComposerFollowUp(
            failedQueueKey,
            preparedForRecovery,
            submittedAttachments,
            sentModelTarget,
            errorMessage,
            sentDispatchOrder,
          );
          recoveredInFollowUpQueue = true;
        } else if (!composerHasNewInput && (composerEditorRef.current?.isEmpty() ?? true)) {
          composerEditorRef.current?.setContent(message, reportCategory);
          rememberComposerDraft(
            composerDraftKeyRef.current ?? submittedDraftKey,
            message,
            reportCategory,
            attachments,
          );
        }
      }
      if (clearedAttachments && !recoveredInFollowUpQueue) {
        // A blocked image attach carries the failed-status chips so the user
        // sees which image didn't go through; fall back to the originals
        // otherwise.
        const restore = err instanceof AttachBlockedError ? err.attachments : submittedAttachments;
        setComposerAttachments((current) => (current.length ? current : restore));
      }
      if (clearedIssueReportReview) {
        const shouldRestoreIssueReportReview =
          !clearedIssueReportReview.deliveryWasSubmitting ||
          submittingIssueReportSessionIdsRef.current.has(clearedIssueReportReview.sessionId) ||
          deferredFailedIssueReportDeliverySessionIdsRef.current.has(
            clearedIssueReportReview.sessionId,
          );
        if (clearedIssueReportReview.queuedReport) {
          dispatchIssueReportFollowUpSubmitFailed({
            storedSessionId: clearedIssueReportReview.sessionId,
            queuedReport: clearedIssueReportReview.queuedReport,
            ...(shouldRestoreIssueReportReview
              ? { restoreReport: clearedIssueReportReview.report }
              : {}),
          });
        }
        if (shouldRestoreIssueReportReview) {
          deferredFailedIssueReportDeliverySessionIdsRef.current.delete(
            clearedIssueReportReview.sessionId,
          );
          setReviewableIssueReport(
            clearedIssueReportReview.sessionId,
            clearedIssueReportReview.report,
          );
        }
      }
      if (err instanceof AgentRunSupersededError) {
        setError(null);
      } else if (isSessionBusyError(err)) {
        // A busy rejection is proof the gateway is healthy — retire any stale
        // connection banner along with showing the nudge.
        setError(null);
        toast(SESSION_BUSY_NOTICE, { id: SESSION_BUSY_TOAST_ID });
      } else {
        setError(errorMessage);
      }
    } finally {
      cancelComposerDispatch(sentDispatchReservation);
      setSubmitting(false);
      setSubmittingHermesSessionId(null);
      // On success the hero is gone; on failure this fades the greeting and
      // suggestions back in behind the restored draft.
      setHeroLeaving(false);
      // Keep the typing flow after a send: a new-session send re-mounts the
      // composer, so defer a frame to focus the live instance — otherwise focus
      // is dropped and can land on the always-on-top agent HUD.
      window.requestAnimationFrame(() => composerEditorRef.current?.focus());
    }
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
        dispatchIssueReportDeliverySettled({ storedSessionId: sessionId, report, result });
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
    liveEventsRef.current = moveHermesLiveStreamKey(
      liveEventsRef.current,
      fromSessionId,
      toSessionId,
    );
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
    for (const id of ids) {
      sessionGatewayUnlistenRef.current.get(id)?.();
      const completionSource = agentRunCompletionSourcesRef.current.get(id);
      if (completionSource) acceptedAgentRunCompletionSourcesRef.current.delete(completionSource);
      agentRunCompletionSourcesRef.current.delete(id);
      handledAgentRunCompletionSourcesRef.current.delete(id);
      workingReconcileMissesRef.current.delete(id);
      agentRunStartRevisionsRef.current.delete(id);
      agentRunAuthorityProofsRef.current.delete(id);
      pendingAgentRunAcceptanceRef.current.delete(id);
      pendingAgentRunTerminalEvidenceRef.current.delete(id);
      agentRunMonitorOwnersRef.current.delete(id);
      forgetLatestAgentRunGeneration(id);
      agentRunMonitorTerminalRegistry.delete(id);
      agentRunTerminalFingerprintsRef.current.delete(id);
      hermesActivityStore.clearSession(id);
    }
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

  function attachHermesSessionEventListener({
    gateway,
    onSuperseded,
    persistenceBoundary,
    predecessorRunMonitorGeneration,
    runAlreadyAccepted = false,
    runtimeIncarnation,
    runtimeSessionId,
    sessionDisplayTitle,
    stageEventsUntilResume = false,
    storedSessionId,
    submittedUserMessage,
    computerUseRunLeaseId,
  }: {
    gateway: HermesGatewayClient;
    onSuperseded?: () => void;
    persistenceBoundary?: AgentRunPersistenceBoundary;
    predecessorRunMonitorGeneration?: number;
    runAlreadyAccepted?: boolean;
    runtimeIncarnation?: HermesRuntimeIncarnation;
    runtimeSessionId: string;
    sessionDisplayTitle: string;
    stageEventsUntilResume?: boolean;
    storedSessionId: string;
    submittedUserMessage?: HermesSessionMessage;
    computerUseRunLeaseId?: string;
  }) {
    const previousUnlisten = sessionGatewayUnlistenRef.current.get(storedSessionId);
    let currentRuntimeSessionId = runtimeSessionId;
    let activeComputerUseRunLeaseId = computerUseRunLeaseId;
    let resumeHandoffPending = stageEventsUntilResume;
    let stagedResumeHandoffEvents: HermesGatewayEvent[] = [];
    const previousAuthorityProof = agentRunAuthorityProofsRef.current.get(storedSessionId);
    const previousRunStartRevision = agentRunStartRevisionsRef.current.get(storedSessionId);
    const previousReconcileMiss = workingReconcileMissesRef.current.get(storedSessionId);
    const previousPendingTerminalEvidence =
      pendingAgentRunTerminalEvidenceRef.current.get(storedSessionId);
    const existingCompletionSource = agentRunCompletionSourcesRef.current.get(storedSessionId);
    if (runAlreadyAccepted) previousUnlisten?.();
    const agentRunListenerEpoch = Symbol(storedSessionId);
    agentRunListenerEpochsRef.current.set(storedSessionId, agentRunListenerEpoch);
    const providedAuthorityProof =
      persistenceBoundary && submittedUserMessage
        ? { persistenceBoundary, runtimeIncarnation, submittedUserMessage }
        : undefined;
    if (providedAuthorityProof) {
      agentRunAuthorityProofsRef.current.set(storedSessionId, providedAuthorityProof);
      pendingAgentRunTerminalEvidenceRef.current.delete(storedSessionId);
    }
    let runAuthorityProof =
      providedAuthorityProof ?? agentRunAuthorityProofsRef.current.get(storedSessionId);
    let listenerRunMonitorGeneration = providedAuthorityProof
      ? undefined
      : agentRunMonitorOwnersRef.current.get(storedSessionId)?.generation;
    const agentRunCompletionSource = existingCompletionSource ?? Symbol(storedSessionId);
    let pendingAcceptance = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
    if (providedAuthorityProof) {
      const predecessorMonitorOwner = agentRunMonitorOwnersRef.current.get(storedSessionId);
      const predecessorMonitorSnapshot = agentRunMonitorSnapshot(storedSessionId);
      const latestKnownGeneration = latestAgentRunGenerationRegistry.get(storedSessionId);
      const predecessorMonitorWasActive = Boolean(
        predecessorMonitorSnapshot &&
          predecessorMonitorSnapshot.phase !== "terminal" &&
          isAgentRunMonitorGenerationCurrent(
            storedSessionId,
            predecessorMonitorSnapshot.generation,
          ) &&
          (predecessorRunMonitorGeneration === undefined ||
            predecessorMonitorSnapshot.generation === predecessorRunMonitorGeneration) &&
          (latestKnownGeneration === undefined ||
            predecessorMonitorSnapshot.generation === latestKnownGeneration),
      );
      const predecessorGenerations = [
        predecessorRunMonitorGeneration,
        predecessorMonitorOwner?.generation,
        predecessorMonitorWasActive ? predecessorMonitorSnapshot?.generation : undefined,
        latestKnownGeneration,
      ].filter((generation): generation is number => generation !== undefined);
      pendingAcceptance = {
        authorityProof: providedAuthorityProof,
        bufferedApprovals: [],
        bufferedTerminals: [],
        candidateRunStarted: false,
        candidateRunStartRevision: liveEventsRef.current[storedSessionId]?.revision ?? 0,
        completionSource: agentRunCompletionSource,
        existingCompletionSource,
        previousAuthorityProof,
        previousPendingTerminalEvidence,
        previousReconcileMiss,
        previousRunStartRevision,
        predecessorMonitorOwner,
        predecessorMonitorWasActive,
        predecessorRunMonitorGeneration:
          predecessorGenerations.length > 0 ? Math.max(...predecessorGenerations) : undefined,
        onSuperseded,
      };
      pendingAgentRunAcceptanceRef.current.set(storedSessionId, pendingAcceptance);
    }
    const runAwaitsAcceptance =
      pendingAcceptance !== undefined &&
      pendingAcceptance.authorityProof === runAuthorityProof &&
      pendingAcceptance.completionSource === agentRunCompletionSource;
    // A newly attached listener is fresh evidence that this Agent run has a live
    // runtime route. Do not carry an earlier absence observation across the
    // reconnect or listener replacement boundary.
    workingReconcileMissesRef.current.delete(storedSessionId);
    if (!existingCompletionSource) {
      agentRunCompletionSourcesRef.current.set(storedSessionId, agentRunCompletionSource);
      if (!agentRunStartRevisionsRef.current.has(storedSessionId)) {
        agentRunStartRevisionsRef.current.set(
          storedSessionId,
          liveEventsRef.current[storedSessionId]?.revision ?? 0,
        );
      }
    }
    if (runAlreadyAccepted && !runAwaitsAcceptance) {
      acceptedAgentRunCompletionSourcesRef.current.add(agentRunCompletionSource);
    }
    let unlisten = () => {};
    let deferredPreAcceptanceTerminals: BufferedAgentRunTerminal[] = [];
    let ambiguousTerminalGeneration = 0;
    let ambiguousTerminalDrainPending = false;
    let ambiguousTerminalCandidates: Array<{
      event: HermesGatewayEvent;
      classified: JuneHermesEvent;
      generation: number;
    }> = [];
    let pendingTerminalEvidence: AgentRunTerminalEvidence | undefined;
    let previousListenerRetired = runAlreadyAccepted || !previousUnlisten;
    const retirePreviousListener = () => {
      if (previousListenerRetired) return;
      previousListenerRetired = true;
      previousUnlisten?.();
    };
    const sourceIsCurrent = () =>
      agentRunCompletionSourcesRef.current.get(storedSessionId) === agentRunCompletionSource &&
      agentRunListenerEpochsRef.current.get(storedSessionId) === agentRunListenerEpoch &&
      agentRunGatewayEventRouteRegistry.get(storedSessionId)?.listenerEpoch ===
        agentRunListenerEpoch;
    const sourceWasHandled = () =>
      handledAgentRunCompletionSourcesRef.current.get(storedSessionId) === agentRunCompletionSource;
    const deletePendingRunAcceptance = () => {
      const pending = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
      if (
        pending?.completionSource === agentRunCompletionSource &&
        pending.authorityProof === runAuthorityProof
      ) {
        pendingAgentRunAcceptanceRef.current.delete(storedSessionId);
      }
    };
    const clearPendingTerminalEvidence = () => {
      pendingTerminalEvidence = undefined;
      const pending = pendingAgentRunTerminalEvidenceRef.current.get(storedSessionId);
      if (
        pending?.completionSource === agentRunCompletionSource &&
        pending.authorityProof === runAuthorityProof
      ) {
        pendingAgentRunTerminalEvidenceRef.current.delete(storedSessionId);
      }
    };
    const latchAgentRunTerminalEvidence = (evidence: AgentRunTerminalEvidence) => {
      if (!runAuthorityProof) return;
      pendingTerminalEvidence = evidence;
      const monitorOwner = agentRunMonitorOwnersRef.current.get(storedSessionId);
      if (
        monitorOwner?.authorityProof === runAuthorityProof &&
        preserveAgentRunTerminalEvidence(storedSessionId, evidence, monitorOwner.generation)
      ) {
        clearPendingTerminalEvidence();
      } else {
        pendingAgentRunTerminalEvidenceRef.current.set(storedSessionId, {
          authorityProof: runAuthorityProof,
          completionSource: agentRunCompletionSource,
          evidence,
        });
      }
    };
    const latchAmbiguousTerminal = (
      classified: JuneHermesEvent,
      notBeforeMs = runAuthorityProof?.persistenceBoundary.promptDispatchedAtMs ??
        runAuthorityProof?.persistenceBoundary.submittedAtMs,
    ) => {
      const status = agentStatusFromHermesEvent(classified);
      if (
        (status !== "completed" && status !== "failed" && status !== "cancelled") ||
        !runAuthorityProof ||
        notBeforeMs === undefined
      ) {
        return false;
      }
      latchAgentRunTerminalEvidence({
        status,
        summary: agentStatusSummaryFromHermesEvent(classified, status),
        notBeforeMs,
      });
      return true;
    };
    const acceptWithCurrentListener = () => {
      if (!sourceIsCurrent() || sourceWasHandled()) return undefined;
      retirePreviousListener();
      acceptedAgentRunCompletionSourcesRef.current.add(agentRunCompletionSource);
      const sharedPending = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
      const acceptance =
        sharedPending?.completionSource === agentRunCompletionSource &&
        sharedPending.authorityProof === runAuthorityProof
          ? sharedPending
          : pendingAcceptance;
      if (acceptance) {
        agentRunStartRevisionsRef.current.set(
          storedSessionId,
          acceptance.candidateRunStartRevision,
        );
        takeDeferredPendingAcceptancePredecessorTerminal(storedSessionId, acceptance);
      }
      const sharedApprovals = acceptance?.bufferedApprovals ?? [];
      if (acceptance) acceptance.bufferedApprovals = [];
      for (const approval of sharedApprovals) {
        if (!sourceIsCurrent() || sourceWasHandled()) break;
        handleGatewayEvent(approval, false, true);
      }
      const sharedDeferred = acceptance?.bufferedTerminals ?? [];
      const deferred = [...sharedDeferred, ...deferredPreAcceptanceTerminals];
      deferredPreAcceptanceTerminals = [];
      for (const terminal of deferred) {
        if (!sourceIsCurrent() || sourceWasHandled()) break;
        // Hermes can emit the predecessor's terminal before prompt.submit
        // acknowledges the replacement. A fresh message.start is the pinned
        // runtime's run boundary: quarantine only terminals observed before
        // that edge when a locally owned or app-lifetime predecessor is proven.
        const terminalBelongsToPredecessor = Boolean(
          !terminal.candidateRunStarted &&
            (acceptance?.existingCompletionSource || acceptance?.predecessorMonitorWasActive),
        );
        if (terminalBelongsToPredecessor) {
          continue;
        }
        handleGatewayEvent(terminal.event, false, true);
      }
      deletePendingRunAcceptance();
      if (!sourceIsCurrent() || sourceWasHandled()) {
        if (acceptance) supersedePendingAcceptancePredecessor(storedSessionId, acceptance);
        return undefined;
      }
      return { confirmMonitorStarted: confirmMonitorStartedWithCurrentListener };
    };
    const confirmRunAccepted = () => {
      const pending = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
      if (providedAuthorityProof && pending !== pendingAcceptance) return undefined;
      if (
        pending?.completionSource === agentRunCompletionSource &&
        pending.authorityProof === runAuthorityProof &&
        pending.acceptWithCurrentListener &&
        pending.acceptWithCurrentListener !== acceptWithCurrentListener
      ) {
        return pending.acceptWithCurrentListener();
      }
      return acceptWithCurrentListener();
    };
    const confirmMonitorStartedWithCurrentListener = (generation: number) => {
      listenerRunMonitorGeneration = generation;
      if (runAuthorityProof) {
        agentRunMonitorTerminalRegistry.delete(storedSessionId);
        rememberLatestAgentRunGeneration(storedSessionId, generation);
        agentRunMonitorOwnersRef.current.set(storedSessionId, {
          authorityProof: runAuthorityProof,
          generation,
        });
        // The queued equal-generation start is deliberately ignored because a
        // current terminal can beat that queue. Repair only an absent or
        // terminal projection here in case acceptance ownership was installed
        // after another surface projected its terminal; preserve any exact
        // waiting/background work already observed for this accepted run.
        const activityPhase = hermesActivityStore.getRecord(storedSessionId)?.phase;
        if (
          activityPhase === undefined ||
          activityPhase === "complete" ||
          activityPhase === "error"
        ) {
          recordSessionRunningActivity(storedSessionId);
        }
      }
      clearPendingTerminalEvidence();
    };
    const restorePredecessorAuthority = (acceptance: PendingAgentRunAcceptance | undefined) => {
      if (acceptance?.existingCompletionSource) {
        runAuthorityProof = acceptance.previousAuthorityProof;
        if (acceptance.previousAuthorityProof) {
          agentRunAuthorityProofsRef.current.set(
            storedSessionId,
            acceptance.previousAuthorityProof,
          );
        } else {
          agentRunAuthorityProofsRef.current.delete(storedSessionId);
        }
        if (acceptance.previousRunStartRevision === undefined) {
          agentRunStartRevisionsRef.current.delete(storedSessionId);
        } else {
          agentRunStartRevisionsRef.current.set(
            storedSessionId,
            acceptance.previousRunStartRevision,
          );
        }
        if (acceptance.previousReconcileMiss) {
          workingReconcileMissesRef.current.set(storedSessionId, acceptance.previousReconcileMiss);
        } else {
          workingReconcileMissesRef.current.delete(storedSessionId);
        }
      } else {
        runAuthorityProof = undefined;
        agentRunAuthorityProofsRef.current.delete(storedSessionId);
        if (acceptance?.previousRunStartRevision === undefined) {
          agentRunStartRevisionsRef.current.delete(storedSessionId);
        } else {
          agentRunStartRevisionsRef.current.set(
            storedSessionId,
            acceptance.previousRunStartRevision,
          );
        }
      }
    };
    const dispatchDeferredPredecessorTerminal = (record: AgentRunMonitorTerminalRecord) => {
      if (record.kind === "status") {
        dispatchAgentSessionStatus(record.detail);
      } else {
        dispatchAgentRunSettled(record.detail);
      }
    };
    const restoreBusyWithCurrentListener = () => {
      if (!sourceIsCurrent() || sourceWasHandled()) return false;
      const currentPending = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
      const acceptance =
        currentPending?.completionSource === agentRunCompletionSource &&
        currentPending.authorityProof === runAuthorityProof
          ? currentPending
          : pendingAcceptance;
      const deferredPredecessorTerminal = acceptance
        ? takeDeferredPendingAcceptancePredecessorTerminal(storedSessionId, acceptance)
        : undefined;
      const rejectedPendingUserMessageId = runAuthorityProof?.submittedUserMessage.id;
      if (rejectedPendingUserMessageId) {
        setPendingHermesMessages((current) => {
          const next = {
            ...current,
            [storedSessionId]: (current[storedSessionId] ?? []).filter(
              (message) => message.id !== rejectedPendingUserMessageId,
            ),
          };
          pendingHermesMessagesRef.current = next;
          return next;
        });
      }
      pendingTerminalEvidence = undefined;
      pendingAgentRunAcceptanceRef.current.delete(storedSessionId);
      if (acceptance?.existingCompletionSource && acceptance.previousPendingTerminalEvidence) {
        pendingAgentRunTerminalEvidenceRef.current.set(
          storedSessionId,
          acceptance.previousPendingTerminalEvidence,
        );
      } else {
        pendingAgentRunTerminalEvidenceRef.current.delete(storedSessionId);
      }
      // A 4009 proves some runtime work exists, but not that Hermes accepted
      // this prompt. Restore a locally owned predecessor or replay its exact
      // generation-matched cross-surface terminal; otherwise keep listening
      // without making the rejected optimistic message persistence authority
      // for that runtime work.
      // The attempted turn's lease is released by its submit catch. This
      // listener now observes the predecessor, whose lease must be retired when
      // that run reaches its terminal edge.
      activeComputerUseRunLeaseId = undefined;
      restorePredecessorAuthority(acceptance);
      retirePreviousListener();
      acceptedAgentRunCompletionSourcesRef.current.add(agentRunCompletionSource);
      const bufferedApprovals = acceptance?.bufferedApprovals ?? [];
      if (acceptance) acceptance.bufferedApprovals = [];
      for (const approval of bufferedApprovals) {
        if (!sourceIsCurrent() || sourceWasHandled()) break;
        handleGatewayEvent(approval);
      }
      for (const terminal of acceptance?.bufferedTerminals ?? []) {
        if (!sourceIsCurrent() || sourceWasHandled()) break;
        const classifiedTerminal = classifyHermesEvent(terminal.event);
        const bufferedFingerprint = hermesTerminalFingerprint(classifiedTerminal);
        if (
          !terminal.candidateRunStarted &&
          !classifiedTerminal.delivery?.eventId &&
          bufferedFingerprint &&
          agentRunTerminalFingerprintsRef.current
            .get(storedSessionId)
            ?.includes(bufferedFingerprint)
        ) {
          // A rejected replacement never established a fresh run boundary.
          // Replaying an anonymous terminal already seen by the predecessor
          // would reinterpret the same timeout under restored authority and
          // duplicate its terminal evidence.
          continue;
        }
        handleGatewayEvent(terminal.event);
      }
      if (deferredPredecessorTerminal && sourceIsCurrent() && !sourceWasHandled()) {
        dispatchDeferredPredecessorTerminal(deferredPredecessorTerminal);
      }
      return sourceIsCurrent() && !sourceWasHandled();
    };
    const restoreRunAfterBusyRejection = () => {
      const pending = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
      if (providedAuthorityProof && pending !== pendingAcceptance) return false;
      if (
        pending?.completionSource === agentRunCompletionSource &&
        pending.authorityProof === runAuthorityProof &&
        pending.restoreBusyWithCurrentListener &&
        pending.restoreBusyWithCurrentListener !== restoreBusyWithCurrentListener
      ) {
        return pending.restoreBusyWithCurrentListener();
      }
      return restoreBusyWithCurrentListener();
    };
    const restorePredecessorAfterRejectedReplacement = () => {
      const acceptance = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
      if (
        !acceptance ||
        acceptance.completionSource !== agentRunCompletionSource ||
        acceptance.authorityProof !== runAuthorityProof
      ) {
        return false;
      }
      const hasRestorablePredecessor = Boolean(
        acceptance.existingCompletionSource ||
          acceptance.predecessorMonitorWasActive ||
          acceptance.deferredPredecessorMonitorTerminal,
      );
      if (!hasRestorablePredecessor) return false;
      const restore = acceptance.restoreBusyWithCurrentListener ?? restoreBusyWithCurrentListener;
      const predecessorRemainsLive = restore();
      return (
        predecessorRemainsLive ||
        pendingAgentRunAcceptanceRef.current.get(storedSessionId) !== acceptance
      );
    };
    const rejectWithCurrentListener = () => {
      if (!sourceIsCurrent()) return false;
      const currentPending = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
      const acceptance =
        currentPending?.completionSource === agentRunCompletionSource &&
        currentPending.authorityProof === runAuthorityProof
          ? currentPending
          : pendingAcceptance;
      if (acceptance) {
        takeDeferredPendingAcceptancePredecessorTerminal(storedSessionId, acceptance);
      }
      (acceptance?.onSuperseded ?? onSuperseded)?.();
      const rejectedPendingUserMessageId = runAuthorityProof?.submittedUserMessage.id;
      if (rejectedPendingUserMessageId) {
        setPendingHermesMessages((current) => {
          const next = {
            ...current,
            [storedSessionId]: (current[storedSessionId] ?? []).filter(
              (message) => message.id !== rejectedPendingUserMessageId,
            ),
          };
          pendingHermesMessagesRef.current = next;
          return next;
        });
      }
      deletePendingRunAcceptance();
      clearPendingTerminalEvidence();
      unlisten();
      handledAgentRunCompletionSourcesRef.current.set(storedSessionId, agentRunCompletionSource);
      acceptedAgentRunCompletionSourcesRef.current.delete(agentRunCompletionSource);
      if (agentRunCompletionSourcesRef.current.get(storedSessionId) === agentRunCompletionSource) {
        agentRunCompletionSourcesRef.current.delete(storedSessionId);
      }
      agentRunStartRevisionsRef.current.delete(storedSessionId);
      agentRunAuthorityProofsRef.current.delete(storedSessionId);
      workingReconcileMissesRef.current.delete(storedSessionId);
      const monitorOwner = agentRunMonitorOwnersRef.current.get(storedSessionId);
      if (monitorOwner?.authorityProof === runAuthorityProof) {
        agentRunMonitorOwnersRef.current.delete(storedSessionId);
      }
      return true;
    };
    const clearPendingRunAcceptance = () => {
      const pending = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
      if (providedAuthorityProof && pending !== pendingAcceptance) return false;
      if (
        pending?.completionSource === agentRunCompletionSource &&
        pending.authorityProof === runAuthorityProof &&
        pending.rejectWithCurrentListener &&
        pending.rejectWithCurrentListener !== rejectWithCurrentListener
      ) {
        return pending.rejectWithCurrentListener();
      }
      return rejectWithCurrentListener();
    };
    const currentPendingAcceptance = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
    if (
      currentPendingAcceptance?.completionSource === agentRunCompletionSource &&
      currentPendingAcceptance.authorityProof === runAuthorityProof
    ) {
      currentPendingAcceptance.acceptWithCurrentListener = acceptWithCurrentListener;
      currentPendingAcceptance.rejectWithCurrentListener = rejectWithCurrentListener;
      currentPendingAcceptance.restoreBusyWithCurrentListener = restoreBusyWithCurrentListener;
    }
    function handleGatewayEvent(
      event: HermesGatewayEvent,
      ambiguityResolved = false,
      acceptanceResolved = false,
    ) {
      // `session.resume` can rebind a live session to a different runtime session id.
      // Stage before the id gate so frames emitted after the server swaps the
      // transport but before its response reaches June cannot fall through the
      // old mapping. The resume ACK later supplies the authoritative id and
      // approval-retirement set before this FIFO is replayed.
      if (resumeHandoffPending) {
        // This queue contains the only client-side copy of frames received
        // before the ACK. Keep it lossless; abort, listener retirement, or
        // successful replay owns its bounded lifetime.
        stagedResumeHandoffEvents.push(event);
        return;
      }
      if (event.session_id !== currentRuntimeSessionId && event.session_id !== storedSessionId) {
        return;
      }
      // This listener has authenticated the origin runtime mapping. Canonicalize
      // only the inter-listener envelope so a recovered listener with a new
      // runtime session id can accept it without relaxing either listener's ingress gate.
      const routedEvent =
        event.session_id === storedSessionId ? event : { ...event, session_id: storedSessionId };
      const currentRoute = agentRunGatewayEventRouteRegistry.get(storedSessionId);
      if (currentRoute?.listenerEpoch !== agentRunListenerEpoch) {
        // The runtime can keep emitting on the transport that submitted this
        // prompt while navigation has already installed a mounted replacement.
        // Route that origin-only frame into the one current semantic listener
        // so live text and terminal side effects land on the visible Workspace.
        if (currentRoute?.completionSource === agentRunCompletionSource) {
          currentRoute.handleEvent(routedEvent);
        }
        return;
      }
      if (!currentRoute.semanticConsumerActive) {
        retainAgentRunGatewayEventForHandoff(
          storedSessionId,
          agentRunCompletionSource,
          routedEvent,
        );
        return;
      }
      // A removed listener can still have a copied callback or an async caller
      // in flight. Its source must never append into, or settle, a newer Agent run.
      if (!sourceIsCurrent()) return;
      const liveEvent = { ...event, receivedAt: new Date().toISOString() };
      // Classify the raw frame once at ingress. Stores and transcript rendering
      // consume the typed event; the raw frame remains only for trace capture
      // and the Stage B status helpers below.
      const classified = classifyHermesEvent(liveEvent);
      const storedEvent = withStoredHermesSessionId(classified, storedSessionId);
      const currentPendingAcceptance = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
      const listenerOwnsPendingAcceptance =
        currentPendingAcceptance !== undefined &&
        currentPendingAcceptance.authorityProof === runAuthorityProof &&
        currentPendingAcceptance.completionSource === agentRunCompletionSource;
      const approvalEvent =
        (storedEvent.kind === "pending_action" && storedEvent.action.kind === "approval") ||
        (storedEvent.kind === "pending_action_resolution" &&
          storedEvent.action.kind === "approval") ||
        storedEvent.kind === "pending_action_expiration";
      if (approvalEvent && listenerOwnsPendingAcceptance && !acceptanceResolved) {
        // A runtime frame can beat prompt.submit's acknowledgement. Keep every
        // approval transition outside the live stream and global stores until
        // this prompt either owns a fresh run boundary or restores its predecessor.
        currentPendingAcceptance.bufferedApprovals.push(routedEvent);
        return;
      }
      const approvalRunEpoch = agentRunStartRevisionsRef.current.get(storedSessionId);
      const transcriptPersistenceProof =
        approvalRunEpoch !== undefined && runAuthorityProof
          ? {
              runStartRevision: approvalRunEpoch,
              authorityProof: runAuthorityProof,
            }
          : undefined;
      const currentSessionEvents =
        liveEventsRef.current[storedSessionId] ?? createHermesLiveStream();
      const retiringApprovalRequestId =
        storedEvent.kind === "pending_action_expiration"
          ? storedEvent.action.requestId
          : storedEvent.kind === "pending_action_resolution" &&
              storedEvent.action.kind === "approval"
            ? storedEvent.action.requestId
            : undefined;
      const retiringApprovalInstanceId = retiringApprovalRequestId
        ? currentHermesApprovalInstanceId(
            currentSessionEvents,
            retiringApprovalRequestId,
            approvalRunEpoch,
          )
        : undefined;
      let storedClassified: JuneHermesEvent = storedEvent;
      if (storedEvent.kind === "pending_action" && storedEvent.action.kind === "approval") {
        storedClassified = {
          ...storedEvent,
          action: {
            ...storedEvent.action,
            instanceId: pendingActionInstanceId(storedEvent.action, approvalRunEpoch),
          },
        };
      } else if (
        storedEvent.kind === "pending_action_resolution" &&
        storedEvent.action.kind === "approval" &&
        retiringApprovalInstanceId
      ) {
        storedClassified = {
          ...storedEvent,
          action: { ...storedEvent.action, instanceId: retiringApprovalInstanceId },
        };
      } else if (storedEvent.kind === "pending_action_expiration" && retiringApprovalInstanceId) {
        storedClassified = {
          ...storedEvent,
          action: { ...storedEvent.action, instanceId: retiringApprovalInstanceId },
        };
      }
      const terminal = isTerminalHermesEvent(classified);
      if (terminal && sourceWasHandled()) return;
      const monitorOwner = agentRunMonitorOwnersRef.current.get(storedSessionId);
      const latestMonitorGeneration = latestAgentRunGenerationRegistry.get(storedSessionId);
      if (
        terminal &&
        listenerRunMonitorGeneration !== undefined &&
        latestMonitorGeneration !== undefined &&
        latestMonitorGeneration > listenerRunMonitorGeneration
      ) {
        // A newer cross-surface run owns this stored session. Even if this
        // listener still has a copied pre-ack callback, its delayed terminal
        // cannot clear shared activity or advance queued continuation work.
        return;
      }
      if (
        terminal &&
        runAuthorityProof !== undefined &&
        !listenerOwnsPendingAcceptance &&
        (monitorOwner?.authorityProof !== runAuthorityProof ||
          !isAgentRunMonitorGenerationCurrent(storedSessionId, monitorOwner.generation))
      ) {
        // Another surface replaced this stored session's app-lifetime monitor.
        // This listener no longer owns terminal UI or continuity effects.
        return;
      }
      const terminalFingerprint = terminal ? hermesTerminalFingerprint(classified) : undefined;
      if (
        terminal &&
        ((listenerOwnsPendingAcceptance && !acceptanceResolved) ||
          !acceptedAgentRunCompletionSourcesRef.current.has(agentRunCompletionSource))
      ) {
        // Hermes may emit a fast terminal from inside prompt.submit before the
        // RPC acknowledgement reaches June. Retain a bounded candidate queue:
        // an old replay can arrive first, and must not displace the real terminal
        // that follows it before the acknowledgement. Once accepted, each
        // candidate still routes through delivery/fingerprint authority below.
        const pending = pendingAgentRunAcceptanceRef.current.get(storedSessionId);
        if (
          pending?.completionSource === agentRunCompletionSource &&
          pending.authorityProof === runAuthorityProof
        ) {
          pending.bufferedTerminals = [
            ...pending.bufferedTerminals,
            { candidateRunStarted: pending.candidateRunStarted, event },
          ].slice(-64);
        } else {
          deferredPreAcceptanceTerminals = [
            ...deferredPreAcceptanceTerminals,
            { candidateRunStarted: pendingAcceptance?.candidateRunStarted ?? false, event },
          ].slice(-64);
        }
        return;
      }
      if (
        terminal &&
        terminalFingerprint &&
        !classified.delivery?.eventId &&
        !ambiguityResolved &&
        agentRunTerminalFingerprintsRef.current
          .get(storedSessionId)
          ?.includes(terminalFingerprint) === true
      ) {
        // A byte-identical lifecycle frame with no replay-stable id is
        // indistinguishable from the prior Agent run's replay. Confirm current
        // Agent run persistence and runtime idleness first. Contradictory
        // failure-plus-assistant evidence remains unresolved until run-fresh
        // persisted terminal metadata identifies its outcome.
        if (agentStatusFromHermesEvent(classified)) {
          latchAmbiguousTerminal(classified);
          ambiguousTerminalGeneration += 1;
          ambiguousTerminalCandidates = [
            ...ambiguousTerminalCandidates,
            { event, classified, generation: ambiguousTerminalGeneration },
          ].slice(-64);
          void drainAmbiguousTerminalCandidates();
        }
        return;
      }
      if (
        (storedClassified.kind === "pending_action_resolution" ||
          storedClassified.kind === "pending_action_expiration") &&
        storedClassified.action.kind === "approval" &&
        !storedClassified.action.instanceId
      ) {
        // A retirement frame with no currently actionable instance is a replay
        // or stale delivery. Do not let its raw compatibility id mutate an old
        // receipt or a later Agent run.
        return;
      }
      const nextSessionEvents = appendHermesLiveEvent(currentSessionEvents, storedClassified, {
        runStartRevision: agentRunStartRevisionsRef.current.get(storedSessionId),
      });
      // Delivery identity is replay-stable when Hermes provides an event id.
      // Reject a replay before it can touch activity, status, or follow-up
      // settlement. A new listener for the next Agent run must not reinterpret
      // the previous Agent run's replayed terminal as its own terminal.
      if (nextSessionEvents === currentSessionEvents) return;
      if (event.type === "message.start" && listenerOwnsPendingAcceptance && !acceptanceResolved) {
        currentPendingAcceptance.candidateRunStarted = true;
      }
      liveEventsRef.current = {
        ...liveEventsRef.current,
        [storedSessionId]: nextSessionEvents,
      };
      setLiveEvents(liveEventsRef.current);
      if (terminal) {
        if (
          listenerOwnsPendingAcceptance &&
          currentPendingAcceptance?.predecessorRunMonitorGeneration !== undefined
        ) {
          rememberSupersededAgentRunGeneration(
            storedSessionId,
            currentPendingAcceptance.predecessorRunMonitorGeneration,
          );
        }
        handledAgentRunCompletionSourcesRef.current.set(storedSessionId, agentRunCompletionSource);
        acceptedAgentRunCompletionSourcesRef.current.delete(agentRunCompletionSource);
        deferredPreAcceptanceTerminals = [];
        ambiguousTerminalCandidates = [];
        clearPendingTerminalEvidence();
        workingReconcileMissesRef.current.delete(storedSessionId);
        agentRunStartRevisionsRef.current.delete(storedSessionId);
        agentRunAuthorityProofsRef.current.delete(storedSessionId);
        if (terminalFingerprint) {
          agentRunTerminalFingerprintsRef.current.set(
            storedSessionId,
            appendAgentRunTerminalFingerprint(
              agentRunTerminalFingerprintsRef.current.get(storedSessionId) ?? [],
              terminalFingerprint,
            ),
          );
        }
      }
      // Feature 15: record every inbound frame (raw type + the kind it
      // classified to) into the bounded, sanitized trace buffer so the dev/debug
      // trace panel can reconstruct the session. recordInbound re-classifies and
      // sanitizes internally; nothing raw is retained.
      hermesTraceBuffer.recordInbound(liveEvent, { storedSessionId });
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
        pendingActionStore.record(storedClassified, hermesModeFor(storedSessionId), {
          approvalRunEpoch,
        });
      } else if (storedClassified.kind === "pending_action_resolution") {
        // Resolution events can arrive independently of this surface's local
        // response promise (for example after reconnect). Reconcile the exact
        // logical request before deriving the session status so another
        // distinct pending action keeps the session in "Needs you".
        pendingActionStore.resolveRequest(
          storedSessionId,
          storedClassified.action.requestId,
          storedClassified.action.kind === "approval"
            ? { instanceId: storedClassified.action.instanceId }
            : undefined,
        );
      } else if (storedClassified.kind === "pending_action_expiration") {
        pendingActionStore.expireRequest(
          storedSessionId,
          storedClassified.action.requestId,
          storedClassified.action.reason,
          { instanceId: storedClassified.action.instanceId },
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
      if (storedClassified.kind === "transcript" && storedClassified.complete) {
        if (storedClassified.failed && runAuthorityProof) {
          const notBeforeMs =
            runAuthorityProof.persistenceBoundary.promptDispatchedAtMs ??
            runAuthorityProof.persistenceBoundary.submittedAtMs;
          latchAgentRunTerminalEvidence({
            status: "failed",
            summary: storedClassified.delta?.trim() || "June hit a problem.",
            notBeforeMs,
          });
        }
        if (
          storedClassified.failed &&
          isUpstreamProviderFailureText(storedClassified.delta ?? "")
        ) {
          // A provider outage is retryable immediately even though the stable
          // run monitor still owns the eventual lifecycle terminal. Remove the
          // optimistic busy projection so the user may start that recovery (or
          // another prompt); the monitor/listener remains authoritative for any
          // late terminal from the failed run.
          clearSessionActivity(storedSessionId, "failed");
        }
        // Hydrate persistence at the message boundary without treating it as
        // the Agent run boundary. Later tool/continuation frames stay subscribed.
        window.setTimeout(() => {
          void refreshHermesSession(storedSessionId, transcriptPersistenceProof);
        }, 300);
      }
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
        const terminalGeneration =
          monitorOwner !== undefined && monitorOwner.authorityProof === runAuthorityProof
            ? monitorOwner.generation
            : undefined;
        if (status === "completed") {
          if (terminalGeneration !== undefined) {
            markAgentRunSucceeded(storedSessionId, terminalGeneration);
          }
        } else if (status === "failed" || status === "cancelled") {
          if (terminalGeneration !== undefined) {
            cancelAgentRunMonitoring(storedSessionId, terminalGeneration);
          }
        }
        dispatchAgentSessionStatus({
          sessionId: storedSessionId,
          title: sessionDisplayTitle,
          status,
          summary: agentStatusSummaryFromHermesEvent(classified, status),
          ...activityCounts,
          ...(terminalGeneration === undefined ? {} : { runMonitorGeneration: terminalGeneration }),
        });
      }
      if (terminal) {
        if (activeComputerUseRunLeaseId) {
          void releaseComputerUseRunLease(storedSessionId, activeComputerUseRunLeaseId).catch(
            () => undefined,
          );
        } else {
          void releaseComputerUseRunsForSession(storedSessionId).catch(() => undefined);
        }
        unlisten();
        if (
          agentRunCompletionSourcesRef.current.get(storedSessionId) === agentRunCompletionSource
        ) {
          agentRunCompletionSourcesRef.current.delete(storedSessionId);
        }
        pendingAgentRunAcceptanceRef.current.delete(storedSessionId);
        if (status !== "completed" && monitorOwner?.authorityProof === runAuthorityProof) {
          agentRunMonitorOwnersRef.current.delete(storedSessionId);
        }
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
        if (promotedIssueReport) {
          queueIssueReportDiagnosisRefresh(storedSessionId, 300, transcriptPersistenceProof);
        } else {
          window.setTimeout(() => {
            void refreshHermesSession(storedSessionId, transcriptPersistenceProof);
          }, 300);
        }
      }
    }
    async function drainAmbiguousTerminalCandidates() {
      if (ambiguousTerminalDrainPending) return;
      ambiguousTerminalDrainPending = true;
      try {
        while (sourceIsCurrent() && !sourceWasHandled() && ambiguousTerminalCandidates.length) {
          const candidate = ambiguousTerminalCandidates.shift();
          if (!candidate) continue;
          await confirmAmbiguousTerminal(
            candidate.event,
            candidate.classified,
            candidate.generation,
          );
        }
      } finally {
        ambiguousTerminalDrainPending = false;
        if (sourceIsCurrent() && !sourceWasHandled() && ambiguousTerminalCandidates.length) {
          void drainAmbiguousTerminalCandidates();
        }
      }
    }
    async function confirmAmbiguousTerminal(
      event: HermesGatewayEvent,
      classified: JuneHermesEvent,
      candidateGeneration: number,
    ) {
      const freshMessages = await listSessionMessagesOrdered(storedSessionId);
      const terminalStatus = agentStatusFromHermesEvent(classified);
      const persistedCurrentUserIndex = runAuthorityProof
        ? persistedPendingUserIndex(
            freshMessages ?? [],
            runAuthorityProof.submittedUserMessage,
            runAuthorityProof.persistenceBoundary,
          )
        : -1;
      const hasPersistedCurrentUser = persistedCurrentUserIndex >= 0;
      const hasAuthoritativeAssistant = Boolean(
        runAuthorityProof &&
          persistedAssistantAfterPendingUser(
            freshMessages ?? [],
            runAuthorityProof.submittedUserMessage,
            runAuthorityProof.persistenceBoundary,
          ),
      );
      const hasCurrentRunPersistence =
        terminalStatus === "completed" ? hasAuthoritativeAssistant : hasPersistedCurrentUser;
      if (
        !freshMessages ||
        !runAuthorityProof ||
        !hasCurrentRunPersistence ||
        candidateGeneration !== ambiguousTerminalGeneration ||
        hermesLiveStreamHasFailedCurrentRun(
          liveEventsRef.current[storedSessionId],
          agentRunStartRevisionsRef.current.get(storedSessionId) ?? 0,
        ) ||
        sourceWasHandled() ||
        !sourceIsCurrent()
      ) {
        return;
      }
      let response: {
        sessions?: Array<{ id?: string; session_key?: string; status?: string }>;
      };
      try {
        response = await gateway.request("session.active_list", {});
      } catch {
        return;
      }
      const matchingRows = (response.sessions ?? []).filter(
        (row) =>
          row.id === currentRuntimeSessionId ||
          row.id === storedSessionId ||
          row.session_key === currentRuntimeSessionId ||
          row.session_key === storedSessionId,
      );
      if (matchingRows.length === 0 || matchingRows.some((row) => row.status !== "idle")) return;
      if (
        candidateGeneration !== ambiguousTerminalGeneration ||
        sourceWasHandled() ||
        !sourceIsCurrent()
      ) {
        return;
      }
      if (
        terminalStatus === "completed" ||
        terminalStatus === "failed" ||
        terminalStatus === "cancelled"
      ) {
        const persistedUserAtMs = hermesMessageTimestampMs(
          freshMessages[persistedCurrentUserIndex],
        );
        const submittedAtMs =
          runAuthorityProof.persistenceBoundary.promptDispatchedAtMs ??
          runAuthorityProof.persistenceBoundary.submittedAtMs;
        latchAmbiguousTerminal(
          classified,
          persistedUserAtMs === undefined
            ? submittedAtMs
            : Math.max(submittedAtMs, persistedUserAtMs),
        );
        return;
      }
      handleGatewayEvent(event, true);
    }
    const rebindRuntimeSessionId = (nextRuntimeSessionId: string) => {
      currentRuntimeSessionId = nextRuntimeSessionId;
    };
    const abortResumeHandoff = () => {
      resumeHandoffPending = false;
      stagedResumeHandoffEvents = [];
    };
    const completeResumeHandoff = (retiredApprovalRequestIds: readonly string[] | undefined) => {
      const retired = new Set(retiredApprovalRequestIds ?? []);
      const hasRetirementProof = retiredApprovalRequestIds !== undefined;
      const staged = stagedResumeHandoffEvents;
      stagedResumeHandoffEvents = [];
      resumeHandoffPending = false;
      for (const event of staged) {
        if (!sourceIsCurrent() || sourceWasHandled()) break;
        const stagedEvent = classifyHermesEvent(event);
        const stagedApprovalRequestId =
          (stagedEvent.kind === "pending_action" && stagedEvent.action.kind === "approval") ||
          (stagedEvent.kind === "pending_action_resolution" &&
            stagedEvent.action.kind === "approval") ||
          stagedEvent.kind === "pending_action_expiration"
            ? stagedEvent.action.requestId
            : undefined;
        // The patched resume snapshot names every request tombstoned by the
        // old notifier generation. Drop only those exact transitions: a fresh
        // approval can legitimately arrive on the replacement transport just
        // before the ACK and must remain actionable.
        if (
          stagedApprovalRequestId &&
          (!hasRetirementProof || retired.has(stagedApprovalRequestId))
        ) {
          continue;
        }
        handleGatewayEvent(event);
      }
    };
    const reconcileResumeSnapshot = (assistant: string, bootstrapIfMissing: boolean) => {
      if (!sourceIsCurrent() || sourceWasHandled()) return;
      const current = liveEventsRef.current[storedSessionId] ?? createHermesLiveStream();
      const reconciled = reconcileHermesInflightSnapshot(current, {
        storedSessionId,
        assistant,
        receivedAt: new Date().toISOString(),
        bootstrapIfMissing,
      });
      if (reconciled === current) return;
      liveEventsRef.current = {
        ...liveEventsRef.current,
        [storedSessionId]: reconciled,
      };
      setLiveEvents(liveEventsRef.current);
    };
    const listenerMountEpoch = workspaceMountEpochRef.current;
    agentRunGatewayEventRouteRegistry.set(storedSessionId, {
      completionSource: agentRunCompletionSource,
      handleEvent: handleGatewayEvent,
      listenerEpoch: agentRunListenerEpoch,
      mountEpoch: listenerMountEpoch,
      retireApprovalsAtPhysicalClose: () =>
        retireApprovalsForGatewayDetach({
          storedSessionIds: new Set([storedSessionId]),
        }),
      semanticConsumerActive: true,
    });
    ownedAgentRunGatewayEventSourcesRef.current.set(storedSessionId, agentRunCompletionSource);
    const registeredDetach = agentRunGatewayPhysicalDetachRegistry.get(storedSessionId);
    if (
      registeredDetach?.completionSource !== agentRunCompletionSource ||
      registeredDetach.mountEpoch !== listenerMountEpoch
    ) {
      const physicalDetach = createAgentRunGatewayPhysicalDetach(
        storedSessionId,
        agentRunCompletionSource,
        listenerMountEpoch,
      );
      agentRunGatewayPhysicalDetachRegistry.set(storedSessionId, physicalDetach);
      ownedAgentRunGatewayPhysicalDetachesRef.current.add(physicalDetach);
    }
    const removeListener = gateway.onEvent(handleGatewayEvent);
    unlisten = () => {
      retirePreviousListener();
      removeListener();
      if (
        agentRunGatewayEventRouteRegistry.get(storedSessionId)?.listenerEpoch ===
        agentRunListenerEpoch
      ) {
        agentRunGatewayEventRouteRegistry.delete(storedSessionId);
        forgetAgentRunGatewayEventHandoff(storedSessionId);
      }
      if (agentRunListenerEpochsRef.current.get(storedSessionId) === agentRunListenerEpoch) {
        agentRunListenerEpochsRef.current.delete(storedSessionId);
      }
      if (sessionGatewayUnlistenRef.current.get(storedSessionId) === unlisten) {
        sessionGatewayUnlistenRef.current.delete(storedSessionId);
      }
    };
    sessionGatewayUnlistenRef.current.set(storedSessionId, unlisten);
    for (const event of takeAgentRunGatewayEventHandoff(
      storedSessionId,
      agentRunCompletionSource,
    )) {
      if (!sourceIsCurrent() || sourceWasHandled()) break;
      handleGatewayEvent(event);
    }
    return {
      abortResumeHandoff,
      authorityProof: providedAuthorityProof,
      clearPendingRunAcceptance,
      completionSource: agentRunCompletionSource,
      clearPendingTerminalEvidence,
      confirmRunAccepted,
      pendingTerminalEvidence: () => {
        const pending = pendingAgentRunTerminalEvidenceRef.current.get(storedSessionId);
        return pending?.completionSource === agentRunCompletionSource &&
          pending.authorityProof === runAuthorityProof
          ? pending.evidence
          : pendingTerminalEvidence;
      },
      promptAttemptIsCurrent: () =>
        !providedAuthorityProof ||
        pendingAgentRunAcceptanceRef.current.get(storedSessionId) === pendingAcceptance,
      completeResumeHandoff,
      rebindRuntimeSessionId,
      reconcileResumeSnapshot,
      restorePredecessorAfterRejectedReplacement,
      restoreRunAfterBusyRejection,
      unlisten,
    };
  }

  async function submitHermesSession(
    content: string,
    explicitSession?: HermesSessionInfo,
    options?: {
      issueReport?: PendingIssueReport;
      displayContent?: string;
      titleContent?: string;
      /** Imported attachments for this turn. Image attachments are sent to the
       * session via the structured image attach flow (feature 19) once the
       * session id is known and before prompt.submit; a failed attach throws to
       * block the send so the user can retry. */
      attachments?: AgentAttachment[];
      /** Background follow-ups must not pull the user into their session. */
      selectSession?: boolean;
      /** Persist structured image attach state before prompt.submit so a retry
       * does not attach the same image twice. */
      onAttachmentsUpdated?: (attachments: AgentAttachment[]) => void;
      /** Model choice captured synchronously when the user pressed Send. */
      modelTarget?: CapturedSessionModelTarget;
      /** Cross-surface generation observed at the direct composer Send
       * boundary. Durable queued follow-ups omit this and capture a fresh
       * baseline when they actually dequeue. */
      runGenerationFence?: { storedSessionId: string; generation?: number };
      /** FIFO slot captured at the same Send boundary as `modelTarget`. */
      dispatchReservation?: HermesSessionDispatchReservation;
      /** Create + select the session and add the user bubble, then stop BEFORE
       * `prompt.submit` (the `/image` flow): the model is never invoked, and the
       * caller renders the result itself. Returns the stored session id so the
       * caller can attach its own turns. Forces the non-optimistic create path so
       * the selected id is the canonical stored id (optimistic migration doesn't
       * move the selection). */
      skipPrompt?: boolean;
    },
  ): Promise<string | undefined> {
    const modelTarget = options?.modelTarget ?? captureSessionModelTarget(explicitSession);
    const targetCatalogModel = generationModelsRef.current.find(
      (model) => model.id === modelTarget.selection.modelId,
    );
    const targetTextFundingContext: TextFundingModelContext = {
      activeModelId: modelTarget.selection.modelId || undefined,
      activeModel: targetCatalogModel,
      veniceApiKeyConfigured: veniceApiKeyConfiguredRef.current,
    };
    if (
      creditActionsDisabledReason &&
      !options?.skipPrompt &&
      shouldBlockTextOnFunding(true, targetTextFundingContext)
    ) {
      throw new Error(creditActionsDisabledReason);
    }
    const displayContent = options?.displayContent ?? content;
    // Explicit-target submissions (background steer/attachment delivery, CLI
    // notices) must use the TARGET session's project, never the ambient one —
    // the user may have a different project session open by then. The ambient
    // context still covers the new-session flow, where the filing is applied
    // only after Hermes returns the session id.
    const submittedProjectContext = explicitSession ? undefined : projectContext;
    const titleContent = options?.titleContent ?? displayContent;
    let attachmentOnlyTitle: string | undefined;
    if (!titleContent.trim() && options?.attachments?.length) {
      const firstName = options.attachments[0].name.trim();
      const extensionIndex = firstName.lastIndexOf(".");
      const firstDisplayName = (
        extensionIndex > 0 ? firstName.slice(0, extensionIndex) : firstName
      ).trim();
      const title =
        options.attachments.length === 1
          ? firstDisplayName
          : `${firstDisplayName} +${options.attachments.length - 1} more`;
      // Array.from splits on Unicode code points, so the cap cannot cut an
      // emoji or surrogate pair in half the way String.slice would.
      attachmentOnlyTitle = Array.from(title.replace(/\s+/g, " "))
        .slice(0, AGENT_TITLE_MAX_CHARS)
        .join("")
        .replace(/[–—]/g, "-")
        .replace(/^([a-z])/, (match) => match.toUpperCase());
    }
    const targetStoredSessionId = modelTarget.targetStoredSessionId ?? undefined;
    const targetRunGenerationAtSend = targetStoredSessionId
      ? options?.runGenerationFence?.storedSessionId === targetStoredSessionId
        ? options.runGenerationFence.generation
        : latestAgentRunGenerationRegistry.get(targetStoredSessionId)
      : undefined;
    let dispatchReservation =
      options?.dispatchReservation ??
      (targetStoredSessionId ? reserveHermesSessionDispatch(targetStoredSessionId) : undefined);
    const targetSessionModelSelection = modelTarget.selection;
    const targetSessionModelId = modelTarget.hermesModelId;
    const targetSessionModelRevision = modelTarget.revision;
    const shouldApplySessionModel = modelTarget.shouldApply;
    // JUN-171 (Phase A): fold any held fast-path `/image` outputs for this
    // session into the turn so they ride the same structured-attach path as
    // composer images and enter the model's context. Never on the skipPrompt
    // (`/image`) path itself — that would flush a prior image with no following
    // prompt (the semantics ADR 0003 decision 2 deliberately avoids).
    const heldFastPathImages =
      options?.skipPrompt || !targetStoredSessionId
        ? []
        : uniqueAttachmentsByWorkspacePath([
            ...(pendingFastPathImagesRef.current[targetStoredSessionId] ?? []),
            ...storedPendingImageSlashAttachments(targetStoredSessionId),
          ]);
    // The video counterpart of the fold above, gated the same way (never on
    // the skipPrompt fast path itself, only on a real follow-up prompt).
    const heldVideoContexts =
      options?.skipPrompt || !targetStoredSessionId
        ? []
        : storedPendingVideoSlashContexts(targetStoredSessionId);
    const agentRunAttachments = [...(options?.attachments ?? []), ...heldFastPathImages];
    const pendingImages = pendingImageAttachments(
      agentRunAttachments.map((attachment) => attachment.attach),
    );
    // Resolve strictly from the catalog: selectedModelOption synthesizes a
    // zero-capability stub for an unknown id, which would read as non-vision and
    // wrongly downgrade a vision-capable (but stale/not-yet-loaded) model. find
    // returns undefined when unresolved so the guard below skips the fallback.
    const targetGenerationModel = targetSessionModelSelection.modelId
      ? generationModelsRef.current.find(
          (model) => model.id === targetSessionModelSelection.modelId,
        )
      : undefined;
    const imageInputFallbackContent =
      // Only downgrade to the text-only fallback when the model is KNOWN to lack
      // image input. An unresolved model id (stale or not-yet-loaded catalog)
      // must NOT be assumed non-vision, or a vision-capable session would
      // silently drop the image and never call attachPendingImages. Mirrors the
      // composer banner's `!!generationModel && !modelSupportsImageInput` guard.
      pendingImages.length &&
      targetGenerationModel &&
      !modelSupportsImageInput(targetGenerationModel)
        ? unsupportedImageInputPrompt({
            displayContent,
            imageNames: pendingImages.map((attachment) => attachment.displayName),
            modelName: targetGenerationModel?.name ?? targetSessionModelSelection.modelId,
            runtimeContent: content,
          })
        : undefined;
    const promptSubmitContent = withVideoFastPathContext(
      promptSubmitContentWithFastPathImageContext(
        imageInputFallbackContent ?? content,
        heldFastPathImages,
      ),
      heldVideoContexts,
    );
    // Issue reports skip title suggestion: the content is the wrapped
    // investigation prompt, which would title the session after the wrapper.
    const titlePromise =
      targetStoredSessionId || options?.issueReport
        ? undefined
        : attachmentOnlyTitle
          ? Promise.resolve(attachmentOnlyTitle)
          : agentSessionTitleForPrompt(titleContent).then((suggestion) => suggestion.title);
    const listedTargetSession = targetStoredSessionId
      ? hermesSessionItemsRef.current.find((session) => session.id === targetStoredSessionId)
      : undefined;
    const fallbackSessionTitle = targetStoredSessionId
      ? explicitSession?.title?.trim() ||
        explicitSession?.preview?.trim() ||
        listedTargetSession?.title?.trim() ||
        listedTargetSession?.preview?.trim() ||
        titleFromPrompt(titleContent)
      : options?.issueReport
        ? "Issue report"
        : attachmentOnlyTitle || titleFromPrompt(titleContent);
    const optimisticSession =
      targetStoredSessionId || options?.skipPrompt
        ? undefined
        : startOptimisticHermesSession({
            displayContent,
            title: fallbackSessionTitle,
            ...(targetSessionModelId ? { model: targetSessionModelId } : {}),
          });
    let storedSessionIdForRollback: string | undefined;
    const rollbackOptimisticBeforePrompt = (err: unknown): never => {
      dispatchReservation?.cancel();
      if (optimisticSession) {
        removeOptimisticHermesSession(optimisticSession.id, storedSessionIdForRollback);
      }
      throw err;
    };
    // The Unrestricted opt-in is made per session: a new session applies the
    // picker draft, and a follow-up routes to the runtime process matching
    // the mode its session was created with. Without this, one Unrestricted
    // session would leave the runtime unsandboxed under every other
    // session's follow-ups.
    const { created, createdUnderProfile, gateway, sessionTitle, storedSessionId } =
      await (async () => {
        const [nextGateway, nextSessionTitle] = await Promise.all([
          ensureHermesGateway(
            targetStoredSessionId
              ? sessionUnrestricted(targetStoredSessionId)
              : fullModeDraftRef.current,
          ),
          titlePromise ?? Promise.resolve(undefined),
          // Re-read the sticky active profile for every brand-new session so an
          // out-of-band switch (Hermes CLI, upstream dashboard) is honored
          // without a workspace remount. Runs in parallel with gateway setup
          // (no added wall-clock) and never throws; the store keeps the
          // last-known value on failure. Both runtimes share one Hermes home,
          // so the value is mode-independent.
          targetStoredSessionId
            ? Promise.resolve()
            : refreshActiveHermesProfile({
                mode: fullModeDraftRef.current ? "unrestricted" : "sandboxed",
              }),
        ]);
        const nextUnderProfileName = targetStoredSessionId
          ? undefined
          : getActiveHermesProfileName();
        const underProfile =
          nextUnderProfileName !== undefined && nextUnderProfileName !== "default";
        const nextCreated = targetStoredSessionId
          ? undefined
          : await nextGateway.request<HermesRuntimeSessionResponse>("session.create", {
              title: nextSessionTitle ?? fallbackSessionTitle,
              cols: 96,
              // session.create treats `model` as a per-session override.
              // Under a named profile the override would silently bypass the
              // profile's own configured text model - the point of profiles -
              // so it is omitted and the profile's model applies.
              ...(targetSessionModelId && !underProfile ? { model: targetSessionModelId } : {}),
              ...(underProfile ? { profile: nextUnderProfileName } : {}),
            });
        const nextStoredSessionId =
          targetStoredSessionId ?? nextCreated?.stored_session_id ?? nextCreated?.session_id;
        if (!nextStoredSessionId) {
          throw new Error("Hermes did not create a session.");
        }
        return {
          created: nextCreated,
          createdUnderProfile: underProfile ? nextUnderProfileName : undefined,
          gateway: nextGateway,
          sessionTitle: nextSessionTitle,
          storedSessionId: nextStoredSessionId,
        };
      })().catch(rollbackOptimisticBeforePrompt);
    storedSessionIdForRollback = storedSessionId;
    if (createdUnderProfile) {
      await assignSessionToProfile(storedSessionId, createdUnderProfile).catch(
        rollbackOptimisticBeforePrompt,
      );
      profileOwnedSessionIdsRef.current.add(storedSessionId);
    }
    const createdSessionModelId = createdUnderProfile ? undefined : targetSessionModelId;
    const activeDispatchReservation =
      dispatchReservation ?? reserveHermesSessionDispatch(storedSessionId);
    dispatchReservation = activeDispatchReservation;
    // Once session.create returns, this Send's captured target is no longer a
    // provisional "new session". If a later attach or prompt step fails after
    // the user has started another draft, recovery can now retain the original
    // message as an Up next item on the durable session.
    if (!modelTarget.targetStoredSessionId) {
      modelTarget.targetStoredSessionId = storedSessionId;
    }
    const runGenerationAtSend = targetStoredSessionId
      ? targetRunGenerationAtSend
      : latestAgentRunGenerationRegistry.get(storedSessionId);
    const promptGenerationIsCurrent = () =>
      latestAgentRunGenerationRegistry.get(storedSessionId) === runGenerationAtSend;
    const supersededPromptError = () =>
      new HermesGatewayError("The session is already running a newer Agent run.", 4009);
    const queuedIssueReport = options?.issueReport;
    const clearQueuedIssueReport = () => {
      if (queuedIssueReport) clearPendingIssueReport(storedSessionId, queuedIssueReport);
    };
    if (!targetStoredSessionId) {
      rememberSessionMode(storedSessionId, fullModeDraftRef.current);
    }
    const sessionDisplayTitle = sessionTitle || fallbackSessionTitle;
    const ensureStoredHermesSession = () =>
      ensureHermesBridgeSession({
        sessionId: storedSessionId,
        ...(!targetStoredSessionId ? { title: sessionDisplayTitle } : {}),
        ...(createdSessionModelId ? { model: createdSessionModelId } : {}),
      });
    if (optimisticSession) {
      await ensureStoredHermesSession().catch(rollbackOptimisticBeforePrompt);
      migrateOptimisticHermesSession({
        clearModel: Boolean(createdUnderProfile),
        createdAt: optimisticSession.createdAt,
        displayContent,
        fromSessionId: optimisticSession.id,
        ...(createdSessionModelId ? { model: createdSessionModelId } : {}),
        title: sessionDisplayTitle,
        toSessionId: storedSessionId,
      });
    }
    if (!targetStoredSessionId && !options?.skipPrompt && !createdUnderProfile) {
      const latestDefaultSelection: SessionModelSelection = {
        modelId: defaultGenerationModelIdRef.current,
        ...(defaultGenerationModelIdRef.current === AUTO_MODEL_ID &&
        generationCostQualityRef.current !== undefined
          ? { costQuality: generationCostQualityRef.current }
          : {}),
      };
      const defaultChangedAfterSend =
        modelTarget.globalIntentRevision !== generationSelectionIntentRevisionRef.current &&
        latestDefaultSelection.modelId &&
        !sameSessionModelSelection(latestDefaultSelection, targetSessionModelSelection);
      if (defaultChangedAfterSend && !sessionModelSelectionsRef.current[storedSessionId]) {
        commitSessionModelSelections(
          stageSessionModelSelection(storedSessionId, latestDefaultSelection),
        );
      }
      // session.create already fixed the live route to the Send-time snapshot.
      // Preserve any newer staged picker choice while recording that actual
      // live route separately.
      commitSessionModelSelections(
        rememberAppliedSessionModelSelection(storedSessionId, targetSessionModelSelection),
      );
    }
    if (sessionTitle) {
      sessionTitleOverridesRef.current = {
        ...sessionTitleOverridesRef.current,
        [storedSessionId]: sessionTitle,
      };
      sessionTitleSourceRef.current = {
        ...sessionTitleSourceRef.current,
        [storedSessionId]: "prompt",
      };
      // The mount-time session load races this store: when its merge lands
      // first, the fetched placeholder title is already rendered and nothing
      // re-reads the override (the post-submit reload can no-op on a stale
      // bridge closure). Re-map the current list so the order doesn't matter.
      setHermesSessionItems((current) => applySessionTitleOverrides(current));
    }
    if (!optimisticSession) {
      await withTimeout(ensureStoredHermesSession(), 2500).catch(() => undefined);
    }
    let runtimeSessionId: string | undefined = created?.session_id;
    const dispatchPreparedSession = async (): Promise<string | undefined> => {
      if (!options?.skipPrompt && !promptGenerationIsCurrent()) {
        throw supersededPromptError();
      }
      // `session.resume` changes the live runtime bound to a stored session.
      // Resolve it only after this Send owns the cross-surface FIFO slot and
      // its generation fence is still current; otherwise a queued Workspace
      // Send could rebind a newer Note Chat Agent run before being rejected.
      let activeRuntimeSessionId: string | undefined =
        runtimeSessionId ?? runtimeSessionIdsRef.current[storedSessionId];
      if (!activeRuntimeSessionId) {
        try {
          activeRuntimeSessionId = (
            await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
              session_id: storedSessionId,
              cols: 96,
            })
          ).session_id;
          runtimeSessionId = activeRuntimeSessionId;
        } catch (err) {
          clearQueuedIssueReport();
          rollbackOptimisticBeforePrompt(err);
        }
      }
      if (!activeRuntimeSessionId) {
        clearQueuedIssueReport();
        activeDispatchReservation.cancel();
        if (optimisticSession) {
          removeOptimisticHermesSession(optimisticSession.id, storedSessionIdForRollback);
        }
        throw new Error("Hermes did not resume the session.");
      }
      // Re-read after acquiring the cross-surface lock. NoteChat may have sent
      // this same stored session and changed its live model after this Send was
      // captured; if so, restore the captured route before accepting the prompt.
      const currentModelEntry = readSessionModelSelections()[storedSessionId];
      const currentStoredModelId = currentModelEntry?.appliedSelection
        ? hermesModelIdForSelection(currentModelEntry.appliedSelection)
        : undefined;
      const mustApplyCapturedModel =
        !options?.skipPrompt &&
        (shouldApplySessionModel ||
          activeDispatchReservation.queuedBehindPrior ||
          (Boolean(targetStoredSessionId) &&
            currentStoredModelId !== undefined &&
            currentStoredModelId !== targetSessionModelId));
      if (mustApplyCapturedModel) {
        try {
          await applySessionModelWhenIdle(() =>
            createHermesMethods(gateway).switchActiveSessionModel({
              mode: hermesModeFor(storedSessionId),
              sessionId: activeRuntimeSessionId,
              model: targetSessionModelId,
            }),
          );
        } catch (err) {
          clearQueuedIssueReport();
          rollbackOptimisticBeforePrompt(err);
        }
        if (targetSessionModelRevision !== undefined) {
          commitSessionModelSelections(
            markSessionModelSelectionApplied(
              storedSessionId,
              targetSessionModelRevision,
              targetSessionModelSelection,
            ),
          );
        } else {
          commitSessionModelSelections(
            rememberAppliedSessionModelSelection(storedSessionId, targetSessionModelSelection),
          );
        }
        const applyModel = (sessions: HermesSessionInfo[]) =>
          sessions.map((session) =>
            session.id === storedSessionId ? { ...session, model: targetSessionModelId } : session,
          );
        hermesSessionItemsRef.current = applyModel(hermesSessionItemsRef.current);
        setHermesSessionItems((current) => applyModel(current));
      }
      if (!imageInputFallbackContent) {
        // Feature 19: send any imported images to the session through the
        // structured image attach flow before the prompt, so the model/tools see
        // them as first-class inputs (not just a path mentioned in prose) and an
        // image-edit prompt names a concrete source. A failed attach throws here,
        // which the submit() catch turns into a restored composer the user can
        // retry — the prompt is NOT sent with a silently-missing image.
        try {
          const updatedAttachments = await attachPendingImages(
            gateway,
            activeRuntimeSessionId,
            storedSessionId,
            agentRunAttachments,
          );
          options?.onAttachmentsUpdated?.(updatedAttachments);
        } catch (err) {
          clearQueuedIssueReport();
          rollbackOptimisticBeforePrompt(err);
        }
      }
      const createdAt = optimisticSession?.createdAt ?? new Date().toISOString();
      let persistenceBoundary: AgentRunPersistenceBoundary;
      if (!targetStoredSessionId) {
        persistenceBoundary = agentRunPersistenceBoundary([], true, Date.parse(createdAt));
      } else {
        try {
          const persistedBeforeDispatch = await withTimeout(
            listHermesSessionMessages(storedSessionId),
            250,
            "Agent dispatch snapshot timed out.",
          );
          persistenceBoundary = agentRunPersistenceBoundary(
            persistedBeforeDispatch,
            true,
            Date.parse(createdAt),
          );
        } catch {
          // Without a fresh ordinal baseline, require the eventual persisted
          // user timestamp to reach the actual dispatch boundary. This may stay
          // unresolved for coarse timestamps, but cannot bless stale prose.
          persistenceBoundary = agentRunPersistenceBoundary([], false, Date.now());
        }
      }
      if (!options?.skipPrompt && !promptGenerationIsCurrent()) {
        clearQueuedIssueReport();
        throw supersededPromptError();
      }
      // React may defer a functional state updater until after navigation has
      // already unmounted this Workspace. Publish the live route to the ref
      // before scheduling state so the unmount continuity snapshot cannot lose
      // the stored-to-runtime mapping for an in-flight prompt.
      runtimeSessionIdsRef.current = {
        ...runtimeSessionIdsRef.current,
        [storedSessionId]: activeRuntimeSessionId,
      };
      setRuntimeSessionIds((current) => ({
        ...current,
        [storedSessionId]: activeRuntimeSessionId,
      }));
      if (!optimisticSession) {
        if (!targetStoredSessionId && options?.skipPrompt) {
          // Media commands do not have a provisional stored session id to receive a
          // picker change while session.create/ensure/resume is in flight. Keep
          // the Send-time model on the media agent run, then take one final snapshot
          // of the new-session default immediately before the stored session
          // becomes active. From that point onward the picker stages changes
          // directly against the stored id.
          const latestDefaultSelection: SessionModelSelection = {
            modelId: defaultGenerationModelIdRef.current,
            ...(defaultGenerationModelIdRef.current === AUTO_MODEL_ID &&
            generationCostQualityRef.current !== undefined
              ? { costQuality: generationCostQualityRef.current }
              : {}),
          };
          const defaultChangedAfterSend =
            modelTarget.globalIntentRevision !== generationSelectionIntentRevisionRef.current &&
            latestDefaultSelection.modelId &&
            !sameSessionModelSelection(latestDefaultSelection, targetSessionModelSelection);
          if (defaultChangedAfterSend) {
            commitSessionModelSelections(
              stageSessionModelSelection(storedSessionId, latestDefaultSelection),
            );
          }
          commitSessionModelSelections(
            rememberAppliedSessionModelSelection(storedSessionId, targetSessionModelSelection),
          );
        }
        if (options?.selectSession !== false) {
          newSessionModeRef.current = false;
          setNewSessionMode(false);
          selectedHermesSessionIdRef.current = storedSessionId;
          setSelectedHermesSessionId(storedSessionId);
          setSelectedTaskId(undefined);
        }
        const optimisticSessionItem: HermesSessionInfo = {
          id: storedSessionId,
          title: sessionDisplayTitle,
          preview: displayContent,
          started_at: createdAt,
          last_active: createdAt,
          message_count: 1,
          ...(createdSessionModelId ? { model: createdSessionModelId } : {}),
        };
        setHermesSessionItems((current) => {
          const existingSession = current.find((session) => session.id === storedSessionId);
          if (existingSession) {
            const mergedSession: HermesSessionInfo = targetStoredSessionId
              ? {
                  ...existingSession,
                  title: existingSession.title?.trim()
                    ? existingSession.title
                    : sessionDisplayTitle,
                  preview: displayContent,
                  last_active: createdAt,
                  message_count:
                    typeof existingSession.message_count === "number"
                      ? existingSession.message_count + 1
                      : optimisticSessionItem.message_count,
                  ...(targetSessionModelId && !existingSession.model?.trim()
                    ? { model: targetSessionModelId }
                    : {}),
                }
              : { ...existingSession, ...optimisticSessionItem };
            return current.map((session) =>
              session.id === storedSessionId ? mergedSession : session,
            );
          }
          return [optimisticSessionItem, ...current];
        });
      }
      const pendingUserMessage: HermesSessionMessage = {
        id: optimisticSession?.userMessage.id ?? `pending:user:${Date.now()}`,
        role: "user",
        content: displayContent,
        timestamp: createdAt,
      };
      if (!optimisticSession && !options?.skipPrompt) {
        setPendingHermesMessages((current) => {
          const next = {
            ...current,
            [storedSessionId]: [...(current[storedSessionId] ?? []), pendingUserMessage],
          };
          pendingHermesMessagesRef.current = next;
          return next;
        });
      }
      // `/image`: the session exists and the user bubble is shown — hand the id
      // back and let the caller render the generated image. No prompt.submit, so
      // the model is never called and no "working" loader competes with the
      // image's own in-thread loader.
      if (options?.skipPrompt) return storedSessionId;
      recordSessionRunningActivity(storedSessionId);
      dispatchAgentSessionStatus({
        sessionId: storedSessionId,
        title: sessionDisplayTitle,
        prompt: displayContent,
        status: "running",
        summary: "June is working.",
      });
      const computerUseRunLeaseId = `${storedSessionId}:${crypto.randomUUID()}`;
      let computerUseRunStarted = false;
      const {
        authorityProof: promptAuthorityProof,
        clearPendingRunAcceptance,
        clearPendingTerminalEvidence,
        completionSource,
        confirmRunAccepted,
        pendingTerminalEvidence,
        promptAttemptIsCurrent,
        restorePredecessorAfterRejectedReplacement,
        restoreRunAfterBusyRejection,
      } = attachHermesSessionEventListener({
        gateway,
        onSuperseded: clearQueuedIssueReport,
        persistenceBoundary,
        predecessorRunMonitorGeneration: runGenerationAtSend,
        runtimeIncarnation: connectedHermesRuntimeIncarnationsRef.current.get(
          sessionUnrestricted(storedSessionId),
        ),
        runtimeSessionId: activeRuntimeSessionId,
        sessionDisplayTitle,
        storedSessionId,
        submittedUserMessage: pendingUserMessage,
        computerUseRunLeaseId,
      });
      try {
        const targetProjectContext = explicitSession
          ? resolveSessionProjectContext?.(storedSessionId)
          : submittedProjectContext;
        const preparedProjectPrompt = prepareProjectPrompt(
          promptSubmitContent,
          targetProjectContext,
          projectContextSignaturesBySessionId.get(storedSessionId),
        );
        await beginComputerUseRunLease(storedSessionId, computerUseRunLeaseId);
        computerUseRunStarted = true;
        // Feature 15: record the outbound prompt.submit in the trace buffer. Its
        // params are sanitized before storage (the text is the user's own prompt,
        // kept; any secret-like value would be masked). This is the primary
        // outbound call from this surface; other RPCs go direct via
        // gateway.request and are not yet traced (see feature 15 notes).
        hermesTraceBuffer.recordOutbound({
          sessionId: storedSessionId,
          method: "prompt.submit",
          params: { session_id: activeRuntimeSessionId, text: preparedProjectPrompt.text },
        });
        // This is the earliest instant at which a terminal or persisted session
        // outcome can belong to this prompt. Keep the earlier optimistic time
        // for matching its eventual persisted user row across preflight waits.
        const promptDispatchedAtMs = Date.now();
        persistenceBoundary.promptDispatchedAtMs = promptDispatchedAtMs;
        if (!persistenceBoundary.historyWasHydrated) {
          persistenceBoundary.submittedAtMs = promptDispatchedAtMs;
        }
        if (queuedIssueReport) {
          // A fresh report session has no earlier assistant rows to exclude.
          // Existing-session follow-ups do, so only they need the dispatch
          // boundary that filters diagnosis history.
          if (targetStoredSessionId) {
            queuedIssueReport.diagnosisStartedAt = new Date(promptDispatchedAtMs).toISOString();
          }
          pendingIssueReportsRef.current.set(storedSessionId, queuedIssueReport);
        }
        const acceptedPromptBoundary: AgentRunPersistenceBoundary = {
          ...persistenceBoundary,
          persistedUserIds: new Set(persistenceBoundary.persistedUserIds),
        };
        await gateway.request("prompt.submit", {
          session_id: activeRuntimeSessionId,
          text: preparedProjectPrompt.text,
        });
        const promptAttemptWasCurrent = promptAttemptIsCurrent();
        if (!promptAttemptWasCurrent || !promptGenerationIsCurrent()) {
          clearQueuedIssueReport();
          if (computerUseRunStarted) {
            await releaseComputerUseRunLease(storedSessionId, computerUseRunLeaseId).catch(
              () => undefined,
            );
          }
          return undefined;
        }
        if (
          queuedIssueReport &&
          pendingIssueReportsRef.current.get(storedSessionId) === queuedIssueReport
        ) {
          acceptedPendingIssueReportRegistry.set(storedSessionId, queuedIssueReport);
        }
        const acceptedListener = confirmRunAccepted();
        if (acceptedListener) {
          const runMonitorGeneration = startAgentRunMonitoring({
            storedSessionId,
            runtimeSessionId: activeRuntimeSessionId,
            runtimeIncarnation: promptAuthorityProof?.runtimeIncarnation,
            title: sessionDisplayTitle,
            fullMode: sessionUnrestricted(storedSessionId),
            settlementHeld: true,
            acceptedPrompt: {
              dispatchedAtMs: promptDispatchedAtMs,
              findPersistedUserIndex: (messages) =>
                persistedPendingUserIndex(
                  [...messages],
                  pendingUserMessage,
                  acceptedPromptBoundary,
                ),
            },
            terminalEvidence: pendingTerminalEvidence(),
          });
          acceptedListener.confirmMonitorStarted(runMonitorGeneration);
        }
        projectContextSignaturesBySessionId.set(
          storedSessionId,
          preparedProjectPrompt.contextSignature,
        );
        // JUN-171 (Phase A): the held fast-path images have now ridden along
        // with a successful follow-up prompt, either as structured image bytes or
        // in the non-vision path fallback. Clear only after prompt.submit accepts
        // the message, so a rejected submit can be retried with the same image
        // context.
        clearHeldFastPathImages(storedSessionId, heldFastPathImages);
        // Same contract for the video fold: clear only after prompt.submit
        // accepts, so a rejected submit retries with the same video context.
        markStoredVideoSlashContextsSent(
          storedSessionId,
          heldVideoContexts.map((videoContext) => videoContext.id),
        );
        await loadHermesSessions({
          suppressStartupRequestError: !hermesSessionsHydratedRef.current,
        });
      } catch (err) {
        if (computerUseRunStarted) {
          await releaseComputerUseRunLease(storedSessionId, computerUseRunLeaseId).catch(
            () => undefined,
          );
        }
        // Record the rejection so the trace panel shows failed outbound calls
        // alongside the inbound stream. messageFromError yields a user-safe string.
        hermesTraceBuffer.recordError({
          sessionId: storedSessionId,
          method: "prompt.submit",
          message: messageFromError(err),
        });
        // A queued report must not outlive its failed prompt; submit() re-arms
        // issue-report mode so the retry can queue it again.
        clearQueuedIssueReport();
        // The prompt never entered the session, so its optimistic bubble must
        // not linger — a retained pending message renders below every later
        // persisted message and reads as a send June ignored.
        setPendingHermesMessages((current) => {
          const next = {
            ...current,
            [storedSessionId]: (current[storedSessionId] ?? []).filter(
              (message) => message.id !== pendingUserMessage.id,
            ),
          };
          pendingHermesMessagesRef.current = next;
          return next;
        });
        if (!promptAttemptIsCurrent()) {
          throw new AgentRunSupersededError();
        }
        if (isSessionBusyError(err)) {
          // The gateway rejected this prompt because the previous agent run is still
          // running — the session itself is healthy, so keep the listener and
          // working state. Callers translate this into the composer notice.
          if (promptAttemptIsCurrent()) restoreRunAfterBusyRejection();
          throw err;
        }
        if (restorePredecessorAfterRejectedReplacement()) throw err;
        const failedMonitorOwner = agentRunMonitorOwnersRef.current.get(storedSessionId);
        const failedOwnerGeneration = failedMonitorOwner?.generation;
        const failedMonitorGeneration =
          failedOwnerGeneration !== undefined &&
          failedMonitorOwner?.authorityProof === promptAuthorityProof &&
          latestAgentRunGenerationRegistry.get(storedSessionId) === failedOwnerGeneration
            ? failedOwnerGeneration
            : undefined;
        if (!clearPendingRunAcceptance()) throw err;
        clearPendingTerminalEvidence();
        sessionGatewayUnlistenRef.current.get(storedSessionId)?.();
        handledAgentRunCompletionSourcesRef.current.set(storedSessionId, completionSource);
        acceptedAgentRunCompletionSourcesRef.current.delete(completionSource);
        if (agentRunCompletionSourcesRef.current.get(storedSessionId) === completionSource) {
          agentRunCompletionSourcesRef.current.delete(storedSessionId);
          agentRunStartRevisionsRef.current.delete(storedSessionId);
        }
        agentRunAuthorityProofsRef.current.delete(storedSessionId);
        workingReconcileMissesRef.current.delete(storedSessionId);
        recordSessionErrorActivity(storedSessionId, messageFromError(err));
        dispatchAgentSessionStatus({
          sessionId: storedSessionId,
          title: sessionDisplayTitle,
          status: "failed",
          summary: messageFromError(err),
          ...(failedMonitorGeneration === undefined
            ? {}
            : { runMonitorGeneration: failedMonitorGeneration }),
        });
        throw err;
      }
      return undefined;
    };

    return trackInFlightSessionDispatch(activeDispatchReservation.run(dispatchPreparedSession));
  }

  // Returns the gateway for the given write-access mode, starting that
  // mode's runtime process if it isn't up. The two modes run side by side
  // (the sandbox is applied at spawn and can't change on a live process, so
  // per-session modes mean a process per mode) — ensuring one never touches
  // the other's process or in-flight work.
  async function ensureHermesGateway(
    fullMode = false,
    options: { refreshBridgeStatus?: boolean } = {},
  ) {
    let status: HermesBridgeStatus | undefined = bridge.running ? bridge : undefined;
    if (options.refreshBridgeStatus) {
      status = await hermesBridgeStatus();
      setBridge(status);
    }
    let connection = hermesConnectionForMode(status, fullMode);
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
    const incarnation = hermesRuntimeIncarnation(connection);
    if (incarnation) {
      connectedHermesRuntimeIncarnationsRef.current.set(fullMode, incarnation);
    } else {
      connectedHermesRuntimeIncarnationsRef.current.delete(fullMode);
    }
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
      const usageFor = async (runtimeSessionId: string) =>
        parseSessionUsage(
          storedSessionId,
          await methods.getSessionUsage({ sessionId: runtimeSessionId }),
        );
      // session.usage reads the live runtime by runtime session id. Keep the lookup in
      // the same cross-surface FIFO as Send because session.resume mutates that
      // binding. During an app-lifetime Agent run, query only the monitor's exact
      // runtime; a missing/dead runtime must fail closed instead of rebinding the
      // stored session underneath the owning surface.
      return trackInFlightSessionDispatch(
        withHermesSessionDispatchLock(storedSessionId, async () => {
          const monitor = agentRunMonitorSnapshot(storedSessionId);
          const activeMonitor = monitor && monitor.phase !== "terminal" ? monitor : undefined;
          if (activeMonitor) {
            if (!activeMonitor.runtimeSessionId) {
              throw new Error(SESSION_BUSY_NOTICE);
            }
            try {
              return await usageFor(activeMonitor.runtimeSessionId);
            } catch (err) {
              if (!isSessionGoneError(messageFromError(err))) throw err;
              throw new Error(SESSION_BUSY_NOTICE);
            }
          }

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
          setRuntimeSessionIds((current) => {
            const next = {
              ...current,
              [storedSessionId]: runtimeSessionId,
            };
            runtimeSessionIdsRef.current = next;
            return next;
          });
          return usageFor(runtimeSessionId);
        }),
      );
    },
    [trackInFlightSessionDispatch],
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
    allowWhileProviderFailureIsLatest: boolean,
  ) {
    if (!storedSessionId || isProvisionalHermesSessionId(storedSessionId)) return;
    if (
      !allowWhileProviderFailureIsLatest &&
      (workingSessionIdsRef.current.has(storedSessionId) ||
        waitingSessionIdsRef.current.has(storedSessionId))
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
  function retireApprovalsForGatewayDetach(
    options: { storedSessionIds?: ReadonlySet<string>; publishMountedState?: boolean } = {},
  ) {
    type LiveApprovalState = {
      instanceId: string;
      storedSessionId: string;
      requestId: string;
      approvalRunEpoch?: number;
      status: "pending" | "resolved" | "expired";
    };

    // The app-wide pending-action store is bounded, so an older open row can
    // be evicted while its semantic live stream still renders the card. Fold
    // both sources and keep resolution/expiration sticky against later replay.
    const liveApprovalStates = new Map<string, LiveApprovalState>();
    for (const [storedSessionId, stream] of Object.entries(liveEventsRef.current)) {
      if (options.storedSessionIds && !options.storedSessionIds.has(storedSessionId)) continue;
      const currentRunStartRevision = agentRunStartRevisionsRef.current.get(storedSessionId);
      for (const { event, revision } of stream.entries) {
        if ((event.kind === "lifecycle" && event.flavor === "terminal") || event.kind === "error") {
          // A terminal stream edge expires every approval that was still open
          // in that run. Preserve that fact even if the bounded activity or
          // pending-action stores have already evicted their corresponding
          // rows; a later detach must not recreate the completed Agent run as active.
          for (const [key, state] of liveApprovalStates) {
            if (state.storedSessionId === storedSessionId && state.status === "pending") {
              liveApprovalStates.set(key, { ...state, status: "expired" });
            }
          }
          continue;
        }
        if (
          (event.kind !== "pending_action" &&
            event.kind !== "pending_action_resolution" &&
            event.kind !== "pending_action_expiration") ||
          event.action.kind !== "approval"
        ) {
          continue;
        }
        const requestId = event.action.requestId;
        if (event.kind === "pending_action") {
          const payloadFingerprintId = event.action.requestIdProvenance === "payload-fingerprint";
          if (
            payloadFingerprintId &&
            currentRunStartRevision !== undefined &&
            revision <= currentRunStartRevision
          ) {
            continue;
          }
          const approvalRunEpoch = payloadFingerprintId ? currentRunStartRevision : undefined;
          const instanceId = pendingActionInstanceId(event.action, approvalRunEpoch);
          const key = approvalResponseKey(storedSessionId, instanceId);
          const existing = liveApprovalStates.get(key);
          if (existing?.status === "resolved" || existing?.status === "expired") continue;
          liveApprovalStates.set(key, {
            instanceId,
            storedSessionId,
            requestId,
            ...(approvalRunEpoch === undefined ? {} : { approvalRunEpoch }),
            status: "pending",
          });
          continue;
        }

        let matched = false;
        for (const [key, state] of liveApprovalStates) {
          if (state.storedSessionId !== storedSessionId || state.requestId !== requestId) continue;
          if (event.action.instanceId && state.instanceId !== event.action.instanceId) continue;
          if (
            state.approvalRunEpoch !== undefined &&
            currentRunStartRevision !== undefined &&
            revision <= currentRunStartRevision
          ) {
            continue;
          }
          matched = true;
          if (event.kind === "pending_action_resolution") {
            liveApprovalStates.set(key, { ...state, status: "resolved" });
          } else if (state.status !== "resolved") {
            liveApprovalStates.set(key, { ...state, status: "expired" });
          }
        }
        if (!matched) {
          // Resolution can be replayed before its request after reconnect. The
          // raw id is the only authority available until a legacy request
          // proves a run-scoped instance; keep this fallback globally sticky.
          const instanceId = requestId;
          liveApprovalStates.set(approvalResponseKey(storedSessionId, instanceId), {
            instanceId,
            storedSessionId,
            requestId,
            status: event.kind === "pending_action_resolution" ? "resolved" : "expired",
          });
        }
      }
    }

    const approvalsToRetire = new Map<
      string,
      Pick<LiveApprovalState, "instanceId" | "storedSessionId" | "requestId">
    >();
    for (const [key, state] of liveApprovalStates) {
      if (state.status === "pending") approvalsToRetire.set(key, state);
    }
    for (const record of pendingActionStore.openRecords()) {
      if (
        record.action.kind !== "approval" ||
        (options.storedSessionIds && !options.storedSessionIds.has(record.sessionId))
      ) {
        continue;
      }
      const key = approvalResponseKey(record.sessionId, record.instanceId);
      const liveState = liveApprovalStates.get(key);
      if (liveState?.status === "resolved" || liveState?.status === "expired") continue;
      approvalsToRetire.set(key, {
        instanceId: record.instanceId,
        storedSessionId: record.sessionId,
        requestId: record.requestId,
      });
    }
    if (approvalsToRetire.size === 0) return;

    let retiredApprovalEvents = liveEventsRef.current;
    let retiredApprovalChanged = false;
    const retiredApprovalStatuses = new Map<
      string,
      { event: JuneHermesEvent; status: AgentSessionStatusKind }
    >();
    const retiredAt = new Date().toISOString();
    for (const { instanceId, storedSessionId, requestId } of approvalsToRetire.values()) {
      // A response that reached Hermes before disconnect may be unacknowledged
      // locally. Retire it so it cannot be sent twice without claiming that
      // nothing was approved when the outcome is unknowable.
      const reason = approvalResponsesInFlightRef.current.has(
        approvalResponseKey(storedSessionId, instanceId),
      )
        ? "unconfirmed"
        : "disconnect";
      pendingActionStore.expireRequest(storedSessionId, requestId, reason, { instanceId });
      const expiration: JuneHermesEvent = {
        kind: "pending_action_expiration",
        sessionId: storedSessionId,
        action: {
          kind: "approval",
          requestId,
          instanceId,
          reason,
        },
        receivedAt: retiredAt,
      };
      const status = recordHermesActivityAndDeriveStatus(expiration, storedSessionId);
      const activityPhase = hermesActivityStore.getRecord(storedSessionId)?.phase;
      if (status && activityPhase !== "complete" && activityPhase !== "error") {
        retiredApprovalStatuses.set(storedSessionId, { event: expiration, status });
      }
      const currentSessionEvents =
        retiredApprovalEvents[storedSessionId] ?? createHermesLiveStream();
      const nextSessionEvents = appendHermesLiveEvent(currentSessionEvents, expiration);
      if (nextSessionEvents !== currentSessionEvents) {
        retiredApprovalEvents = {
          ...retiredApprovalEvents,
          [storedSessionId]: nextSessionEvents,
        };
        retiredApprovalChanged = true;
      }
    }
    if (retiredApprovalChanged) {
      liveEventsRef.current = retiredApprovalEvents;
      if (options.publishMountedState !== false) setLiveEvents(retiredApprovalEvents);
    }
    for (const [storedSessionId, { event, status }] of retiredApprovalStatuses) {
      dispatchAgentSessionStatus({
        sessionId: storedSessionId,
        title:
          hermesSessionItemsRef.current.find((session) => session.id === storedSessionId)?.title ??
          "Agent session",
        status,
        summary: agentStatusSummaryFromHermesEvent(event, status),
      });
    }
  }

  async function recoverFromGatewayClose(fullMode: boolean) {
    // onClose fires only after this mode's socket has physically detached.
    // Resolve and retire the old per-run barrier now; the replacement listener
    // below registers a fresh barrier for its replacement transport.
    const physicallyDetachedRuns = new Map<string, AgentRunGatewayPhysicalDetach>();
    for (const [storedSessionId, physicalDetach] of agentRunGatewayPhysicalDetachRegistry) {
      if (sessionUnrestricted(storedSessionId) !== fullMode) continue;
      physicallyDetachedRuns.set(storedSessionId, physicalDetach);
      physicalDetach.resolve();
      if (agentRunGatewayPhysicalDetachRegistry.get(storedSessionId) === physicalDetach) {
        agentRunGatewayPhysicalDetachRegistry.delete(storedSessionId);
      }
      ownedAgentRunGatewayPhysicalDetachesRef.current.delete(physicalDetach);
    }
    // Approval retirement is a property of every physical gateway close, not
    // of whether reconnect work is needed or already running. Derive its
    // session scope from the synchronous semantic/store sources so a close in
    // the same event-loop task as approval.request cannot race React's activity refs.
    const storedSessionIdsWithApprovals = new Set<string>();
    for (const [storedSessionId, stream] of Object.entries(liveEventsRef.current)) {
      if (sessionUnrestricted(storedSessionId) !== fullMode) continue;
      if (
        stream.entries.some(
          ({ event }) =>
            (event.kind === "pending_action" ||
              event.kind === "pending_action_resolution" ||
              event.kind === "pending_action_expiration") &&
            event.action.kind === "approval",
        )
      ) {
        storedSessionIdsWithApprovals.add(storedSessionId);
      }
    }
    for (const record of pendingActionStore.openRecords()) {
      if (record.action.kind === "approval" && sessionUnrestricted(record.sessionId) === fullMode) {
        storedSessionIdsWithApprovals.add(record.sessionId);
      }
    }
    // The patched Hermes gateway denies and drains unresolved MCP approvals
    // when its notification socket disconnects. Mirror that fail-closed
    // boundary before every recovery guard: an old card must never remain
    // actionable against a newly resumed runtime. Other pending-action kinds
    // keep their existing stale/reannounce reconciliation contract.
    retireApprovalsForGatewayDetach({ storedSessionIds: storedSessionIdsWithApprovals });

    if (gatewayRecoveringRef.current.has(fullMode)) {
      gatewayRecoveryRetryRequestedRef.current.add(fullMode);
      return;
    }
    const activeStoredSessionIds = new Set(
      [...workingSessionIdsRef.current, ...waitingSessionIdsRef.current].filter(
        (storedSessionId) => sessionUnrestricted(storedSessionId) === fullMode,
      ),
    );
    if (!activeStoredSessionIds.size) return;
    const recoveryRuns = new Map(
      Array.from(activeStoredSessionIds).flatMap((storedSessionId) => {
        const source = agentRunCompletionSourcesRef.current.get(storedSessionId);
        const monitorOwner = agentRunMonitorOwnersRef.current.get(storedSessionId);
        return source && monitorOwner
          ? ([[storedSessionId, { monitorOwner, source }]] as const)
          : [];
      }),
    );
    // Reserve the transport gate synchronously, before reconnect yields. It
    // must overtake a queued Send whose dormant FIFO slot cannot start until a
    // terminal frame from this resumed stream arrives.
    const recoveryTransportHandoffs = new Map(
      Array.from(recoveryRuns.keys()).map((storedSessionId) => [
        storedSessionId,
        reserveHermesSessionTransportHandoff(storedSessionId),
      ]),
    );
    gatewayRecoveringRef.current.add(fullMode);
    try {
      const gateway = await ensureHermesGateway(fullMode, { refreshBridgeStatus: true });
      await Promise.all(
        Array.from(recoveryRuns).map(async ([storedSessionId, recoveryRun]) => {
          const { monitorOwner: recoveryMonitorOwner, source: recoverySource } = recoveryRun;
          const recoveryTransportHandoff = recoveryTransportHandoffs.get(storedSessionId);
          if (!recoveryTransportHandoff) return;
          let recoveryListener: ReturnType<typeof attachHermesSessionEventListener> | undefined;
          let recoveryListenerPhysicalDetach: AgentRunGatewayPhysicalDetach | undefined;
          const recoveryOwnershipIsCurrent = () =>
            agentRunCompletionSourcesRef.current.get(storedSessionId) === recoverySource &&
            handledAgentRunCompletionSourcesRef.current.get(storedSessionId) !== recoverySource &&
            agentRunMonitorOwnersRef.current.get(storedSessionId) === recoveryMonitorOwner &&
            agentRunAuthorityProofsRef.current.get(storedSessionId) ===
              recoveryMonitorOwner.authorityProof &&
            latestAgentRunGenerationRegistry.get(storedSessionId) ===
              recoveryMonitorOwner.generation &&
            isAgentRunMonitorGenerationCurrent(storedSessionId, recoveryMonitorOwner.generation);
          const recoveryRunIsCurrent = () =>
            recoveryOwnershipIsCurrent() &&
            (recoveryListenerPhysicalDetach === undefined ||
              agentRunGatewayPhysicalDetachRegistry.get(storedSessionId) ===
                recoveryListenerPhysicalDetach);
          const abortRecoveryListener = () => {
            recoveryListener?.abortResumeHandoff();
            recoveryListener?.unlisten();
          };
          try {
            await trackInFlightSessionDispatch(
              recoveryTransportHandoff.run(async () => {
                await physicallyDetachedRuns.get(storedSessionId)?.detached;
                if (!recoveryRunIsCurrent()) return;
                const provisionalRuntimeSessionId =
                  runtimeSessionIdsRef.current[storedSessionId] ?? storedSessionId;
                recoveryListener = attachHermesSessionEventListener({
                  gateway,
                  runAlreadyAccepted: true,
                  runtimeSessionId: provisionalRuntimeSessionId,
                  sessionDisplayTitle:
                    hermesSessionItemsRef.current.find((session) => session.id === storedSessionId)
                      ?.title ?? "Agent session",
                  stageEventsUntilResume: true,
                  storedSessionId,
                });
                const activeRecoveryListener = recoveryListener;
                recoveryListenerPhysicalDetach =
                  agentRunGatewayPhysicalDetachRegistry.get(storedSessionId);
                if (!recoveryRunIsCurrent()) {
                  abortRecoveryListener();
                  return;
                }
                const resumed = await gateway.request<HermesRuntimeSessionResponse>(
                  "session.resume",
                  {
                    session_id: storedSessionId,
                    cols: 96,
                  },
                );
                const resumedRuntimeSessionId = resumed.session_id;
                if (!resumedRuntimeSessionId || !recoveryRunIsCurrent()) {
                  abortRecoveryListener();
                  const currentMonitor = agentRunMonitorSnapshot(storedSessionId);
                  const runtimeBelongsToCurrentMonitor =
                    currentMonitor?.phase !== "terminal" &&
                    currentMonitor?.runtimeSessionId === resumedRuntimeSessionId;
                  if (
                    resumedRuntimeSessionId &&
                    resumedRuntimeSessionId !== runtimeSessionIdsRef.current[storedSessionId] &&
                    !runtimeBelongsToCurrentMonitor
                  ) {
                    await gateway
                      .request("session.interrupt", {
                        session_id: resumedRuntimeSessionId,
                      })
                      .catch(() => undefined);
                  }
                  return;
                }
                activeRecoveryListener.rebindRuntimeSessionId(resumedRuntimeSessionId);
                reconcileHermesRuntimeReplacementAfterResume(
                  storedSessionId,
                  resumed,
                  connectedHermesRuntimeIncarnationsRef.current.get(fullMode),
                );
                recordHermesResumePersistenceBoundary(
                  storedSessionId,
                  resumed.messages,
                  resumed.pending_message_complete,
                );
                // Process-replacement reconciliation runs while replacement
                // frames remain staged. Replay them next, then append only a
                // missing suffix from the atomic in-flight snapshot.
                activeRecoveryListener.completeResumeHandoff(resumed.retired_approval_request_ids);
                const inflightAssistant = resumed.inflight?.assistant;
                if (typeof inflightAssistant === "string" && inflightAssistant.length > 0) {
                  activeRecoveryListener.reconcileResumeSnapshot(
                    inflightAssistant,
                    resumed.running !== false && resumed.inflight?.streaming !== false,
                  );
                }
                runtimeSessionIdsRef.current = {
                  ...runtimeSessionIdsRef.current,
                  [storedSessionId]: resumedRuntimeSessionId,
                };
                setRuntimeSessionIds((current) => ({
                  ...current,
                  [storedSessionId]: resumedRuntimeSessionId,
                }));
              }),
            );
          } catch {
            recoveryTransportHandoff.cancel();
            abortRecoveryListener();
            // The runtime session may be gone; the poll reconciles it.
          }
        }),
      );
    } catch {
      for (const recoveryTransportHandoff of recoveryTransportHandoffs.values()) {
        recoveryTransportHandoff.cancel();
      }
      // Reconnect failed — fall back to the persisted-message poll.
    } finally {
      gatewayRecoveringRef.current.delete(fullMode);
      if (gatewayRecoveryRetryRequestedRef.current.delete(fullMode)) {
        void recoverFromGatewayClose(fullMode);
      }
    }
    // Feature 04: the gateway is back. Any non-approval pending action not
    // re-announced by a fresh event is unverifiable across the drop, so mark it
    // stale rather than silently dropping a possible blocker. Approvals were
    // already retired above because the gateway drains them fail closed.
    pendingActionStore.reconcileAfterReconnect();
    for (const storedSessionId of activeStoredSessionIds) {
      void refreshHermesSession(storedSessionId);
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
    const monitorOwner = agentRunMonitorOwnersRef.current.get(storedSessionId);
    if (monitorOwner) {
      cancelAgentRunMonitoring(storedSessionId, monitorOwner.generation);
    }
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
    const monitorOwner = agentRunMonitorOwnersRef.current.get(storedSessionId);
    if (monitorOwner) {
      releaseAgentRunSettlement(storedSessionId, monitorOwner.generation);
    }
  }

  async function reconcileWorkingSessionsAgainstRuntime() {
    const reconciliationMountEpoch = workspaceMountEpochRef.current;
    if (!reconciliationMountEpoch) return;
    const reconciliationMountIsCurrent = () =>
      workspaceMountEpochRef.current === reconciliationMountEpoch;
    const working = Array.from(workingSessionIdsRef.current);
    const expectedCompletionSources = new Map(
      working.map((sessionId) => [sessionId, agentRunCompletionSourcesRef.current.get(sessionId)]),
    );
    const expectedAuthorityProofs = new Map(
      working.map((sessionId) => [sessionId, agentRunAuthorityProofsRef.current.get(sessionId)]),
    );
    const expectedMonitorOwners = new Map(
      working.map((sessionId) => [sessionId, agentRunMonitorOwnersRef.current.get(sessionId)]),
    );
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
    if (!reconciliationMountIsCurrent() || snapshot.reachableModes.size === 0) return;
    for (const sessionId of working) {
      const expectedCompletionSource = expectedCompletionSources.get(sessionId);
      const expectedAuthorityProof = expectedAuthorityProofs.get(sessionId);
      const expectedMonitorOwner = expectedMonitorOwners.get(sessionId);
      const runIsCurrent = () =>
        reconciliationMountIsCurrent() &&
        workingSessionIdsRef.current.has(sessionId) &&
        agentRunCompletionSourcesRef.current.get(sessionId) === expectedCompletionSource &&
        agentRunAuthorityProofsRef.current.get(sessionId) === expectedAuthorityProof &&
        agentRunMonitorOwnersRef.current.get(sessionId) === expectedMonitorOwner &&
        (!expectedMonitorOwner ||
          isAgentRunMonitorGenerationCurrent(sessionId, expectedMonitorOwner.generation)) &&
        (!expectedCompletionSource ||
          handledAgentRunCompletionSourcesRef.current.get(sessionId) !== expectedCompletionSource);
      if (!runIsCurrent()) {
        misses.delete(sessionId);
        continue;
      }
      // Sessions of an unreachable mode were not in any answer we got;
      // counting them as misses would mark live work dead.
      if (!snapshot.reachableModes.has(sessionUnrestricted(sessionId))) continue;
      if (runtimeSnapshotHasSession(snapshot, sessionId)) {
        misses.delete(sessionId);
        continue;
      }
      const previousMiss = misses.get(sessionId);
      const seen =
        (previousMiss && previousMiss.completionSource === expectedCompletionSource
          ? previousMiss.count
          : 0) + 1;
      if (seen < 2) {
        misses.set(sessionId, { completionSource: expectedCompletionSource, count: seen });
        continue;
      }
      misses.delete(sessionId);
      const freshMessages = await refreshHermesSession(sessionId);
      if (!freshMessages || !runIsCurrent()) continue;
      const localTerminalEvidence = pendingAgentRunTerminalEvidenceRef.current.get(sessionId);
      const hasCurrentLocalTerminalEvidence =
        localTerminalEvidence !== undefined &&
        localTerminalEvidence.completionSource === expectedCompletionSource &&
        localTerminalEvidence.authorityProof === expectedAuthorityProof;
      const pendingAcceptance = pendingAgentRunAcceptanceRef.current.get(sessionId);
      const hasCurrentPendingAcceptance =
        pendingAcceptance !== undefined &&
        pendingAcceptance.completionSource === expectedCompletionSource &&
        pendingAcceptance.authorityProof === expectedAuthorityProof;
      const monitorHasPendingTerminalEvidence =
        expectedMonitorOwner !== undefined &&
        hasPendingAgentRunTerminalEvidence(sessionId, expectedMonitorOwner.generation);
      if (
        hasCurrentPendingAcceptance ||
        hasCurrentLocalTerminalEvidence ||
        monitorHasPendingTerminalEvidence
      ) {
        // An unacknowledged prompt or replay-ambiguous terminal is tri-state.
        // Partial assistant prose plus idle cannot bypass its owning listener
        // or app-lifetime monitor.
        continue;
      }
      const failedMessageCompletion = hermesLiveStreamHasFailedCurrentRun(
        liveEventsRef.current[sessionId],
        agentRunStartRevisionsRef.current.get(sessionId) ?? 0,
      );
      const persistedCurrentUserIndex = expectedAuthorityProof
        ? persistedPendingUserIndex(
            freshMessages,
            expectedAuthorityProof.submittedUserMessage,
            expectedAuthorityProof.persistenceBoundary,
          )
        : undefined;
      if (expectedAuthorityProof && persistedCurrentUserIndex === -1) {
        // Runtime absence cannot settle an Agent run until persistence proves
        // its current user prompt. Otherwise an older identical exchange can be
        // mistaken for this Agent run after a reconnect loses its final event.
        continue;
      }
      const hasAuthoritativeAssistant = expectedAuthorityProof
        ? persistedAssistantAfterPendingUser(
            freshMessages,
            expectedAuthorityProof.submittedUserMessage,
            expectedAuthorityProof.persistenceBoundary,
          )
        : sessionHasAssistantAfterLatestUser(freshMessages);
      if (hasAuthoritativeAssistant && !failedMessageCompletion) {
        // Persisted assistant text is not itself an Agent run terminal. At this
        // point the runtime has also authoritatively reported the session idle
        // twice, so it is safe to settle the Agent run even if its final lifecycle
        // frame was lost during a gateway drop.
        sessionGatewayUnlistenRef.current.get(sessionId)?.();
        if (expectedCompletionSource) {
          handledAgentRunCompletionSourcesRef.current.set(sessionId, expectedCompletionSource);
          acceptedAgentRunCompletionSourcesRef.current.delete(expectedCompletionSource);
        }
        if (agentRunCompletionSourcesRef.current.get(sessionId) === expectedCompletionSource) {
          agentRunCompletionSourcesRef.current.delete(sessionId);
        }
        agentRunStartRevisionsRef.current.delete(sessionId);
        agentRunAuthorityProofsRef.current.delete(sessionId);
        pendingAgentRunAcceptanceRef.current.delete(sessionId);
        pendingAgentRunTerminalEvidenceRef.current.delete(sessionId);
        void releaseComputerUseRunsForSession(sessionId).catch(() => undefined);
        promotePendingIssueReportToReview(sessionId, {
          queueDiagnosisRefresh: false,
        });
        const activityCounts = clearSessionActivity(sessionId);
        if (expectedMonitorOwner) {
          markAgentRunSucceeded(sessionId, expectedMonitorOwner.generation);
        }
        dispatchAgentSessionStatus({
          sessionId,
          title:
            hermesSessionItems.find((session) => session.id === sessionId)?.title ??
            "Agent session",
          status: "completed",
          summary: "June finished.",
          ...activityCounts,
          ...(expectedMonitorOwner === undefined
            ? {}
            : { runMonitorGeneration: expectedMonitorOwner.generation }),
        });
        continueAfterCompletedAgentRun(sessionId, expectedCompletionSource);
        continue;
      }
      const title =
        hermesSessionItems.find((session) => session.id === sessionId)?.title ?? "Agent session";
      const summary = "June stopped before replying.";
      sessionGatewayUnlistenRef.current.get(sessionId)?.();
      if (expectedCompletionSource) {
        handledAgentRunCompletionSourcesRef.current.set(sessionId, expectedCompletionSource);
        acceptedAgentRunCompletionSourcesRef.current.delete(expectedCompletionSource);
      }
      if (agentRunCompletionSourcesRef.current.get(sessionId) === expectedCompletionSource) {
        agentRunCompletionSourcesRef.current.delete(sessionId);
      }
      agentRunStartRevisionsRef.current.delete(sessionId);
      agentRunAuthorityProofsRef.current.delete(sessionId);
      pendingAgentRunAcceptanceRef.current.delete(sessionId);
      pendingAgentRunTerminalEvidenceRef.current.delete(sessionId);
      void releaseComputerUseRunsForSession(sessionId).catch(() => undefined);
      cancelAgentRunSettlement(sessionId);
      agentRunMonitorOwnersRef.current.delete(sessionId);
      clearSubmittedSteers(sessionId);
      recordSessionErrorActivity(sessionId, summary);
      setError(summary, { sessionId });
      dispatchAgentSessionStatus({
        sessionId,
        title,
        status: "failed",
        summary,
        ...agentActivityCountsFromStore(),
        ...(expectedMonitorOwner === undefined
          ? {}
          : { runMonitorGeneration: expectedMonitorOwner.generation }),
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

  function reconcilePersistedHermesLiveEvents(
    storedSessionId: string,
    messages: HermesSessionMessage[],
    throughRevision: number,
    transcriptPersistenceProof?: AgentRunTranscriptPersistenceProof,
  ) {
    const current = liveEventsRef.current[storedSessionId];
    if (!current) return;
    const persistedRunAssistantTexts = transcriptPersistenceProof
      ? persistedAssistantTextsForAgentRun(messages, transcriptPersistenceProof.authorityProof)
      : undefined;
    const reconciled = reconcileHermesLiveStream(current, {
      throughRevision,
      persistedMessages: persistedAssistantMessagesById(messages),
      ...(persistedRunAssistantTexts && transcriptPersistenceProof
        ? {
            idlessTranscriptRun: {
              runStartRevision: transcriptPersistenceProof.runStartRevision,
              persistedAssistantTexts: persistedRunAssistantTexts,
              persistedAssistantBoundaries: (current.idlessTranscriptPersistenceBoundaries ?? [])
                .filter(
                  (boundary) =>
                    boundary.runStartRevision === transcriptPersistenceProof.runStartRevision &&
                    boundary.revision <= throughRevision,
                )
                .map((boundary) => ({
                  revision: boundary.revision,
                  persistedAssistantOrdinal: boundary.persistedAssistantOrdinal,
                  ...(boundary.pendingMessageComplete
                    ? { pendingMessageComplete: true as const }
                    : {}),
                })),
            },
          }
        : {}),
    });
    if (reconciled === current) return;
    liveEventsRef.current = {
      ...liveEventsRef.current,
      [storedSessionId]: reconciled,
    };
    setLiveEvents(liveEventsRef.current);
  }

  function recordHermesResumePersistenceBoundary(
    storedSessionId: string,
    rawMessages: unknown[] | undefined,
    pendingMessageComplete: HermesRuntimeSessionResponse["pending_message_complete"],
  ) {
    if (!Array.isArray(rawMessages)) return;
    const runStartRevision = agentRunStartRevisionsRef.current.get(storedSessionId);
    const authorityProof = agentRunAuthorityProofsRef.current.get(storedSessionId);
    if (runStartRevision === undefined || !authorityProof) return;
    const messages = normalizeAtomicHermesResumeMessages(rawMessages);
    const persistedRun = persistedAssistantRunForAtomicResume(
      messages,
      authorityProof,
      pendingMessageComplete?.assistant_ordinal,
    );
    if (!persistedRun) return;
    const current = liveEventsRef.current[storedSessionId] ?? createHermesLiveStream();
    const next = recordHermesIdlessTranscriptPersistenceBoundary(current, {
      runStartRevision,
      persistedAssistantOrdinal:
        persistedRun.pendingCompleteRunOrdinal ?? persistedRun.assistantTexts.length,
      pendingMessageComplete: persistedRun.pendingCompleteRunOrdinal !== undefined,
    });
    if (next === current) return;
    liveEventsRef.current = {
      ...liveEventsRef.current,
      [storedSessionId]: next,
    };
    setLiveEvents(liveEventsRef.current);
  }

  function reconcileHermesRuntimeReplacementAfterResume(
    storedSessionId: string,
    resumed: HermesRuntimeSessionResponse,
    replacementRuntimeIncarnation: HermesRuntimeIncarnation | undefined,
  ) {
    if (!Array.isArray(resumed.messages)) return;
    const runStartRevision = agentRunStartRevisionsRef.current.get(storedSessionId);
    const authorityProof = agentRunAuthorityProofsRef.current.get(storedSessionId);
    if (runStartRevision === undefined || !authorityProof) return;
    const persistedRun = persistedAssistantRunForAtomicResume(
      normalizeAtomicHermesResumeMessages(resumed.messages),
      authorityProof,
      undefined,
    );
    if (!persistedRun) return;
    const inflightAssistant = resumed.inflight?.assistant;
    const replacementHasActiveInflightAssistant = Boolean(
      resumed.inflight &&
        (resumed.inflight.streaming !== false ||
          (typeof inflightAssistant === "string" && inflightAssistant.length > 0)),
    );
    const current = liveEventsRef.current[storedSessionId] ?? createHermesLiveStream();
    const next = reconcileHermesLiveStreamAfterRuntimeReplacement(current, {
      throughRevision: current.revision,
      runStartRevision,
      acceptedRuntimeIncarnation: authorityProof.runtimeIncarnation,
      replacementRuntimeIncarnation,
      replacementRunning: resumed.running,
      replacementHasActiveInflightAssistant,
      replacementHasPendingMessageComplete: resumed.pending_message_complete !== undefined,
      persistedAssistantTexts: persistedRun.assistantTexts,
    });
    if (next === current) return;
    liveEventsRef.current = {
      ...liveEventsRef.current,
      [storedSessionId]: next,
    };
    setLiveEvents(liveEventsRef.current);
  }

  async function refreshHermesSession(
    sessionId: string,
    transcriptPersistenceProof?: AgentRunTranscriptPersistenceProof,
  ) {
    try {
      const throughRevision = liveEventsRef.current[sessionId]?.revision ?? 0;
      const activeRunStartRevision = agentRunStartRevisionsRef.current.get(sessionId);
      const activeRunAuthorityProof = agentRunAuthorityProofsRef.current.get(sessionId);
      const capturedTranscriptPersistenceProof =
        transcriptPersistenceProof ??
        (activeRunStartRevision !== undefined && activeRunAuthorityProof
          ? {
              runStartRevision: activeRunStartRevision,
              authorityProof: activeRunAuthorityProof,
            }
          : undefined);
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
      reconcilePersistedHermesLiveEvents(
        sessionId,
        messages,
        throughRevision,
        capturedTranscriptPersistenceProof,
      );
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
    instanceId: string,
    choice: AgentApprovalChoice,
    unrestricted = false,
  ) {
    const responseKey = approvalResponseKey(liveEventKey, instanceId);
    // The card disables on the next render; guard synchronously too so a rapid
    // second activation cannot target the same logical approval twice.
    if (approvalResponsesInFlightRef.current.has(responseKey)) return;
    approvalResponsesInFlightRef.current.set(responseKey, choice);
    setApprovalSubmitting((current) => ({ ...current, [responseKey]: choice }));
    const responseStillTargetsOpenInstance = () => {
      const stream = liveEventsRef.current[liveEventKey];
      return (
        stream !== undefined &&
        currentHermesApprovalInstanceId(
          stream,
          requestId,
          agentRunStartRevisionsRef.current.get(liveEventKey),
        ) === instanceId
      );
    };
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
      if (!responseStillTargetsOpenInstance()) return;
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
        pendingActionStore.expireRequest(liveEventKey, requestId, "stale", { instanceId });
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
      pendingActionStore.resolveRequest(liveEventKey, requestId, { instanceId });
      recordOptimisticHermesActivityAndDispatchStatus(resolution, liveEventKey);
      setError(null);
    } catch (err) {
      if (!responseStillTargetsOpenInstance()) return;
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
        pendingActionStore.expireRequest(liveEventKey, requestId, "disconnect", { instanceId });
        void loadHermesSessions();
        setError(SESSION_GONE_MESSAGE, { sessionId });
      } else {
        setError(message, { sessionId });
      }
    } finally {
      approvalResponsesInFlightRef.current.delete(responseKey);
      setApprovalSubmitting((current) => {
        const next = { ...current };
        delete next[responseKey];
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
        raw = await trackInFlightSessionDispatch(
          withHermesSessionDispatchLock(sessionId, async () => {
            // The fallback can rebind the source's live transport. Re-read both
            // ownership and the runtime alias inside the stored-session FIFO so
            // Branch cannot resume underneath another surface's Agent run.
            const currentMonitor = agentRunMonitorSnapshot(sessionId);
            if (currentMonitor && currentMonitor.phase !== "terminal") {
              throw new Error(SESSION_BUSY_NOTICE);
            }

            let runtimeSessionId: string | undefined = runtimeSessionIdsRef.current[sessionId];
            if (runtimeSessionId) {
              try {
                return await branchVia(runtimeSessionId);
              } catch (runtimeErr) {
                if (!isSessionGoneError(messageFromError(runtimeErr))) throw runtimeErr;
                runtimeSessionId = undefined;
              }
            }

            const resumed = await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
              session_id: sessionId,
              cols: 96,
            });
            runtimeSessionId = resumed.session_id;
            if (!runtimeSessionId) throw new Error("Hermes did not resume the session.");
            const resumedRuntimeSessionId = runtimeSessionId;
            setRuntimeSessionIds((current) => ({
              ...current,
              [sessionId]: resumedRuntimeSessionId,
            }));
            runtimeSessionIdsRef.current = {
              ...runtimeSessionIdsRef.current,
              [sessionId]: resumedRuntimeSessionId,
            };
            return branchVia(resumedRuntimeSessionId);
          }),
        );
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
        [result.sessionId]: createHermesLiveStream(),
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
    const nextEvents = appendHermesLiveEvent(
      liveEventsRef.current[key] ?? createHermesLiveStream(),
      withStoredHermesSessionId(event, key),
    );
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
    const continuation = completedAgentRunContinuationRegistry.get(storedSessionId);
    if (continuation?.timer !== undefined) window.clearTimeout(continuation.timer);
    continuation?.resolveDeliverySettled?.();
    completedAgentRunContinuationRegistry.delete(storedSessionId);
    forgetQueuedAttachmentFollowUpDelivery(storedSessionId);
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
    let removedItem = false;
    updateQueuedAttachmentFollowUps(queueKey, (items) => {
      const removed = items.find((item) => item.id === itemId && item.status !== "sending");
      removedItem = Boolean(removed);
      removed?.dispatchReservation?.cancel();
      return items.filter((item) => item.id !== itemId || item.status === "sending");
    });
    if (removedItem) forgetQueuedAttachmentFollowUpDelivery(queueKey, itemId);
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
      const monitorOwner = agentRunMonitorOwnersRef.current.get(queueKey);
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
      publishQueuedAttachmentFollowUpDelivery({
        queueKey,
        itemId: item.id,
        status: "failed",
        error: summary,
      });
      cancelAgentRunSettlement(queueKey);
      dispatchAgentSessionStatus({
        sessionId: queueKey,
        title: "Agent session",
        status: "failed",
        summary,
        ...(monitorOwner === undefined ? {} : { runMonitorGeneration: monitorOwner.generation }),
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
    publishQueuedAttachmentFollowUpDelivery({
      queueKey,
      itemId: item.id,
      status: "sending",
      attachments: item.attachments,
    });
    let deliveryAttachments = item.attachments;
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
          deliveryAttachments = nextAttachments;
          updateQueuedAttachmentFollowUps(queueKey, (items) =>
            items.map((candidate) =>
              candidate.id === item.id ? { ...candidate, attachments: nextAttachments } : candidate,
            ),
          );
          publishQueuedAttachmentFollowUpDelivery({
            queueKey,
            itemId: item.id,
            status: "sending",
            attachments: nextAttachments,
          });
        },
      });
      updateQueuedAttachmentFollowUps(queueKey, (items) =>
        items.filter((candidate) => candidate.id !== item.id),
      );
      publishQueuedAttachmentFollowUpDelivery({
        queueKey,
        itemId: item.id,
        status: "sent",
      });
      return true;
    } catch (err) {
      dispatchReservation?.cancel();
      const failedAttachments =
        err instanceof AttachBlockedError ? err.attachments : deliveryAttachments;
      const error = messageFromError(err);
      updateQueuedAttachmentFollowUps(queueKey, (items) =>
        items.map((candidate) =>
          candidate.id === item.id
            ? {
                ...candidate,
                attachments: failedAttachments,
                dispatchReservation: undefined,
                status: "failed",
                error,
              }
            : candidate,
        ),
      );
      publishQueuedAttachmentFollowUpDelivery({
        queueKey,
        itemId: item.id,
        status: "failed",
        attachments: failedAttachments,
        error,
      });
      return false;
    }
  }

  function releasePendingCompletedAgentRunContinuations(owner: symbol) {
    for (const continuation of completedAgentRunContinuationRegistry.values()) {
      if (continuation.phase !== "pending" || continuation.owner !== owner) continue;
      if (continuation.timer !== undefined) window.clearTimeout(continuation.timer);
      continuation.timer = undefined;
      continuation.owner = undefined;
    }
  }

  function prepareCompletedAgentRunContinuation(
    storedSessionId: string,
    continuation: CompletedAgentRunContinuationRecord,
  ) {
    if (continuation.prepared) return;
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
    continuation.prepared = true;
    continuation.steerFollowUpIds = steerFollowUps.map((followUp) => followUp.id);
  }

  function finishCompletedAgentRunContinuation(
    storedSessionId: string,
    continuation: CompletedAgentRunContinuationRecord,
    watchForSettlement: boolean,
  ) {
    if (completedAgentRunContinuationRegistry.get(storedSessionId) !== continuation) return;
    continuation.resolveDeliverySettled?.();
    continuation.deliverySettled = undefined;
    continuation.resolveDeliverySettled = undefined;
    const pendingSource = continuation.pendingSource;
    if (pendingSource) {
      continuation.generation = continuation.pendingGeneration;
      continuation.source = pendingSource;
      continuation.pendingSource = undefined;
      continuation.pendingGeneration = undefined;
      continuation.phase = "pending";
      continuation.owner = undefined;
      continuation.timer = undefined;
      continuation.prepared = false;
      continuation.steerFollowUpIds = [];
      notifyCompletedAgentRunContinuationPending(storedSessionId);
      return;
    }
    completedAgentRunContinuationRegistry.delete(storedSessionId);
    if (watchForSettlement) watchCompletedAgentRunSettle(storedSessionId);
  }

  function claimCompletedAgentRunContinuation(storedSessionId: string) {
    const continuation = completedAgentRunContinuationRegistry.get(storedSessionId);
    const owner = workspaceMountEpochRef.current;
    if (
      !bridge.running ||
      !continuation ||
      continuation.phase !== "pending" ||
      continuation.owner ||
      !owner
    ) {
      return;
    }
    continuation.owner = owner;
    prepareCompletedAgentRunContinuation(storedSessionId, continuation);
    continuation.timer = window.setTimeout(async () => {
      if (
        completedAgentRunContinuationRegistry.get(storedSessionId) !== continuation ||
        continuation.owner !== owner ||
        workspaceMountEpochRef.current !== owner
      ) {
        return;
      }
      continuation.timer = undefined;
      if (latestAgentRunGenerationRegistry.get(storedSessionId) !== continuation.generation) {
        // A newer run owns this session now. Keep the queued user work intact;
        // its own terminal will advance the queue when that run completes.
        finishCompletedAgentRunContinuation(storedSessionId, continuation, false);
        return;
      }
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
        finishCompletedAgentRunContinuation(storedSessionId, continuation, false);
        return;
      }
      if (continuation.steerFollowUpIds.length) {
        const followUpSession = hermesSessionItemsRef.current.find(
          (session) => session.id === storedSessionId,
        );
        if (!followUpSession) {
          for (const followUpId of continuation.steerFollowUpIds) {
            removeQueuedAttachmentFollowUp(storedSessionId, followUpId);
          }
          finishCompletedAgentRunContinuation(storedSessionId, continuation, false);
          return;
        }
      }
      continuation.phase = "delivering";
      continuation.deliverySettled = new Promise<void>((resolve) => {
        continuation.resolveDeliverySettled = resolve;
      });
      if (continuation.steerFollowUpIds.length) {
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
          finishCompletedAgentRunContinuation(storedSessionId, continuation, !followUpStarted);
        }
        return;
      }
      let followUpStarted = false;
      try {
        followUpStarted = await deliverQueuedAttachmentFollowUp(storedSessionId, undefined, {
          afterCompletion: true,
        });
      } finally {
        finishCompletedAgentRunContinuation(storedSessionId, continuation, !followUpStarted);
      }
    }, 0);
  }

  function continueAfterCompletedAgentRun(storedSessionId: string, source?: symbol) {
    const continuing = completedAgentRunContinuationRegistry.get(storedSessionId);
    if (continuing) {
      if (source && source !== continuing.source && source !== continuing.pendingSource) {
        continuing.pendingSource = source;
        continuing.pendingGeneration = latestAgentRunGenerationRegistry.get(storedSessionId);
      }
      if (continuing.phase === "pending" && !continuing.owner) {
        notifyCompletedAgentRunContinuationPending(storedSessionId);
      }
      return;
    }
    completedAgentRunContinuationRegistry.set(storedSessionId, {
      generation: latestAgentRunGenerationRegistry.get(storedSessionId),
      source,
      phase: "pending",
      prepared: false,
      steerFollowUpIds: [],
    });
    notifyCompletedAgentRunContinuationPending(storedSessionId);
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
    const monitorOwner = agentRunMonitorOwnersRef.current.get(sessionId);
    const latestGeneration = latestAgentRunGenerationRegistry.get(sessionId);
    const activeRunMonitorGeneration = Math.max(
      monitorOwner?.generation ?? Number.NEGATIVE_INFINITY,
      latestGeneration ?? Number.NEGATIVE_INFINITY,
    );
    const taggedRunMonitorGeneration = Number.isFinite(activeRunMonitorGeneration)
      ? activeRunMonitorGeneration
      : undefined;
    const stopDispatchHold = holdHermesSessionDispatch(sessionId);
    // Revoke the native broker before waiting for the Hermes interrupt. This
    // cancels pending approvals, kills the helper, clears captures, and makes
    // Stop sticky until a later visible chat turn opens a fresh lease.
    const computerUseStopRequest = stopComputerUseRuns().catch(() => undefined);
    const monitorStopAccepted =
      taggedRunMonitorGeneration !== undefined &&
      stopAgentRunMonitoring(sessionId, taggedRunMonitorGeneration, () => {
        void refreshHermesSession(sessionId);
        stopDispatchHold.release();
      });
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
    const completionSource = agentRunCompletionSourcesRef.current.get(sessionId);
    if (completionSource) {
      handledAgentRunCompletionSourcesRef.current.set(sessionId, completionSource);
      acceptedAgentRunCompletionSourcesRef.current.delete(completionSource);
      agentRunCompletionSourcesRef.current.delete(sessionId);
    }
    workingReconcileMissesRef.current.delete(sessionId);
    agentRunStartRevisionsRef.current.delete(sessionId);
    agentRunAuthorityProofsRef.current.delete(sessionId);
    const pendingAcceptance = pendingAgentRunAcceptanceRef.current.get(sessionId);
    const unacceptedUserMessageId = pendingAcceptance?.authorityProof.submittedUserMessage.id;
    const tentativeIssueReport = pendingIssueReportsRef.current.get(sessionId);
    if (
      pendingAcceptance &&
      tentativeIssueReport &&
      acceptedPendingIssueReportRegistry.get(sessionId) !== tentativeIssueReport
    ) {
      clearPendingIssueReport(sessionId, tentativeIssueReport);
      deferredFailedIssueReportDeliverySessionIdsRef.current.delete(sessionId);
    }
    if (unacceptedUserMessageId) {
      setPendingHermesMessages((current) => {
        const next = {
          ...current,
          [sessionId]: (current[sessionId] ?? []).filter(
            (message) => message.id !== unacceptedUserMessageId,
          ),
        };
        pendingHermesMessagesRef.current = next;
        return next;
      });
    }
    pendingAgentRunAcceptanceRef.current.delete(sessionId);
    pendingAgentRunTerminalEvidenceRef.current.delete(sessionId);
    agentRunMonitorOwnersRef.current.delete(sessionId);
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
      ...(taggedRunMonitorGeneration === undefined
        ? {}
        : { runMonitorGeneration: taggedRunMonitorGeneration }),
    });

    try {
      await computerUseStopRequest;
      const runtimeSessionId = runtimeSessionIds[sessionId];
      const localOwnerCanInterrupt =
        taggedRunMonitorGeneration === undefined ||
        monitorOwner?.generation === taggedRunMonitorGeneration;
      if (!monitorStopAccepted && localOwnerCanInterrupt && runtimeSessionId) {
        let stopExpired = false;
        const interrupt = (async () => {
          const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
          if (stopExpired) return;
          await gateway.request("session.interrupt", {
            session_id: runtimeSessionId,
          });
        })();
        const timeout = new Promise<void>((resolve) => {
          window.setTimeout(() => {
            stopExpired = true;
            resolve();
          }, 2000);
        });
        await Promise.race([interrupt, timeout]);
        stopExpired = true;
      }
    } catch {
      // The UI already reflects stopped; a failed interrupt (gateway down)
      // must not leave the session reading as working.
    } finally {
      if (!monitorStopAccepted) stopDispatchHold.release();
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
    clearPendingIssueReport(sessionId);
    deferredFailedIssueReportDeliverySessionIdsRef.current.delete(sessionId);
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
            hermesLiveEvents(liveEvents[selectedHermesSessionId] ?? createHermesLiveStream()),
          ),
        ),
        ...(imageTurnsBySession[selectedHermesSessionId] ?? []),
        ...(videoTurnsBySession[selectedHermesSessionId] ?? []),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  const upstreamFailureRecoveryIds = upstreamProviderRecoveryIds(hermesTurns);
  const latestUpstreamFailureTurnId = Array.from(upstreamFailureRecoveryIds.keys()).at(-1);
  const currentRunStartRevision = selectedHermesSessionId
    ? (pendingAgentRunAcceptanceRef.current.get(selectedHermesSessionId)
        ?.candidateRunStartRevision ??
      agentRunStartRevisionsRef.current.get(selectedHermesSessionId))
    : undefined;
  const currentRunHasUpstreamProviderFailure = Boolean(
    selectedHermesSessionId &&
      currentRunStartRevision !== undefined &&
      liveEvents[selectedHermesSessionId]?.entries.some(
        ({ event, revision }) =>
          revision > currentRunStartRevision &&
          event.kind === "transcript" &&
          event.complete &&
          event.failed &&
          isUpstreamProviderFailureText(event.delta ?? ""),
      ),
  );
  const taskTurns = selectedTask
    ? mergeThinkingTurns(
        buildAgentChatTurns(
          selectedTask.messages,
          selectedTask.toolEvents,
          hermesLiveEvents(liveEvents[selectedTask.id] ?? createHermesLiveStream()),
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
          composerModelCommandPalette ? (
            <ModelCommandPalette
              model={generationModel}
              options={modelOptions(generationModelOptions, generationModel?.id ?? "")}
              search={modelSearch}
              popoverRef={composerModelPopoverRef}
              searchRef={composerModelSearchRef}
              onSearchChange={setModelSearch}
              onSelect={(modelId) => {
                void handleSelectGenerationModel(modelId);
                composerEditorRef.current?.focus();
              }}
            />
          ) : (
            <ModelPickerPopover
              mode="generation"
              flyout={composerModelFlyout}
              model={generationModel}
              options={modelOptions(generationModelOptions, generationModel?.id ?? "")}
              costQuality={activeGenerationCostQuality}
              veniceApiKeyConfigured={veniceApiKeyConfigured}
              search={modelSearch}
              popoverRef={composerModelPopoverRef}
              searchRef={composerModelSearchRef}
              onFlyoutChange={setComposerModelFlyout}
              onSearchChange={setModelSearch}
              onSelect={(modelId, costQuality, options) =>
                void handleSelectGenerationModel(modelId, costQuality, options)
              }
              onCostQualityChange={handleCostQualityChange}
            />
          )
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
          approvalScopeId={selectedHermesSessionId}
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
              turn.id === latestUpstreamFailureTurnId && currentRunHasUpstreamProviderFailure,
            )
          }
          upstreamFailureRetryAttempted={upstreamProviderRecoveryStore.attempted(
            selectedHermesSessionId,
            upstreamFailureRecoveryIds.get(turn.id) ?? "",
          )}
          upstreamFailureRetryDisabled={
            (workingSessionIds.has(selectedHermesSessionId) ||
              waitingSessionIds.has(selectedHermesSessionId)) &&
            (turn.id !== latestUpstreamFailureTurnId || !currentRunHasUpstreamProviderFailure)
          }
          creditActionsDisabledReason={creditActionsDisabledReason}
          onApproval={(part, choice) =>
            void respondToApproval(
              selectedHermesSessionId,
              runtimeSessionIds[selectedHermesSessionId] ??
                part.sessionId ??
                selectedHermesSessionId,
              part.id,
              part.instanceId ?? part.id,
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
              runtimeSessionIds[selectedHermesSessionId] ??
                part.sessionId ??
                selectedHermesSessionId,
              part.id,
              approved,
              part.mode,
              sessionUnrestricted(selectedHermesSessionId),
            )
          }
          onSecret={(part, value) =>
            void respondToSecret(
              selectedHermesSessionId,
              runtimeSessionIds[selectedHermesSessionId] ??
                part.sessionId ??
                selectedHermesSessionId,
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
            approvalScopeId={selectedTask.id}
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
                part.instanceId ?? part.id,
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

// Persistent, full-width session bar — same chrome as the Notes/Folders
// breadcrumb. Stays pinned while the conversation scrolls beneath it, carries
// the back arrow + origin crumbs (Projects / {project} or Agents), the
// private-mode badge, and folds rename/delete into an overflow menu so the
// conversation keeps the focus (no separate title heading).
function AgentSessionBar({
  origin,
  privacyBadge,
  fullMode,
  title,
  shareUrl,
  artifactCount = 0,
  artifactsOpen = false,
  inProject = false,
  projectContext,
  onToggleArtifacts,
  onRename,
  onShare,
  onMoveToProject,
  onDelete,
  onShowUsage,
  onCompactContext,
  onOpenTuiDebug,
}: {
  origin?: AgentWorkspaceOrigin;
  privacyBadge?: ModelPrivacyBadge;
  fullMode?: boolean;
  title?: string;
  shareUrl?: string;
  artifactCount?: number;
  artifactsOpen?: boolean;
  inProject?: boolean;
  projectContext?: AgentProjectContext;
  onToggleArtifacts?: () => void;
  onRename?: (title: string) => void;
  /** Opens the private-sharing dialog for this session (JUN-308). */
  onShare?: () => void;
  /** Opens the change-project dialog (which also owns removal). */
  onMoveToProject?: () => void;
  onDelete?: () => void;
  onShowUsage?: () => void;
  onCompactContext?: () => void;
  /** Developer-only: open this session in Hermes' raw TUI. Undefined (and the
   * menu item absent) in production builds. */
  onOpenTuiDebug?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointer(event: MouseEvent) {
      if (!menuWrapRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function commitRename() {
    setRenaming(false);
    onRename?.(draft);
  }

  const hasMenu = Boolean(
    onRename ||
      onShare ||
      onMoveToProject ||
      onDelete ||
      onShowUsage ||
      onCompactContext ||
      onOpenTuiDebug,
  );

  return (
    <div className="detail-bar agent-session-bar" data-tauri-drag-region>
      {origin ? <BackButton label={origin.backLabel} onClick={origin.onBack} /> : null}
      <nav className="detail-breadcrumb" aria-label="Breadcrumb">
        <ol>
          {origin ? (
            origin.crumbs.map((crumb, index) => (
              <li key={`${crumb.label}-${index}`}>
                {index > 0 ? (
                  <span className="detail-breadcrumb-separator" aria-hidden>
                    /
                  </span>
                ) : null}
                <button type="button" className="detail-breadcrumb-link" onClick={crumb.onClick}>
                  {crumb.icon ? (
                    <span className="detail-breadcrumb-icon" aria-hidden>
                      {crumb.icon}
                    </span>
                  ) : null}
                  {crumb.label}
                </button>
              </li>
            ))
          ) : (
            <li>
              <span className="detail-breadcrumb-label">Session</span>
            </li>
          )}
          {title !== undefined ? (
            <li>
              <span className="detail-breadcrumb-separator" aria-hidden>
                /
              </span>
              {renaming ? (
                <input
                  className="agent-session-rename"
                  aria-label="Session name"
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename();
                    }
                    if (event.key === "Escape") {
                      setRenaming(false);
                      setDraft(title ?? "");
                    }
                  }}
                />
              ) : (
                <span className="detail-breadcrumb-current-group">
                  <span className="detail-breadcrumb-current">{title || "Untitled session"}</span>
                  {shareUrl ? <ShareLinkCopyAction url={shareUrl} /> : null}
                </span>
              )}
            </li>
          ) : origin ? (
            <li>
              <span className="detail-breadcrumb-separator" aria-hidden>
                /
              </span>
              <span className="detail-breadcrumb-current">New session</span>
            </li>
          ) : null}
        </ol>
      </nav>
      <div className="detail-bar-actions">
        {projectContext ? (
          <button
            type="button"
            className="agent-project-instructions"
            onClick={() => setInstructionsOpen(true)}
          >
            Project instructions
          </button>
        ) : null}
        {fullMode ? <UnrestrictedBadge /> : null}
        {onToggleArtifacts && artifactCount > 0 ? (
          <button
            type="button"
            className="agent-session-files"
            aria-label={`View files (${artifactCount})`}
            title="View files"
            aria-pressed={artifactsOpen}
            onClick={onToggleArtifacts}
          >
            <IconFiles size={14} />
            <span aria-hidden>{artifactCount}</span>
          </button>
        ) : null}
        <PrivacyModeBadge badge={privacyBadge} />
        {hasMenu ? (
          <div className="agent-session-menu-wrap" ref={menuWrapRef}>
            <button
              type="button"
              className="icon-button agent-session-menu-trigger"
              aria-label="Session actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <IconDotGrid1x3Horizontal size={16} />
            </button>
            {menuOpen ? (
              <div className="sidebar-identity-menu agent-session-menu" role="menu">
                {onRename ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setDraft(title ?? "");
                      setRenaming(true);
                    }}
                  >
                    <IconPencil size={14} />
                    Rename
                  </button>
                ) : null}
                {onShare ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onShare();
                    }}
                  >
                    <IconShareOs size={14} />
                    Share
                  </button>
                ) : null}
                {onMoveToProject ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onMoveToProject();
                    }}
                  >
                    {inProject ? <IconMoveFolder size={14} /> : <IconFolderAddRight size={14} />}
                    {inProject ? "Change project" : "Add to project"}
                  </button>
                ) : null}
                {(onRename || onShare || onMoveToProject) && (onShowUsage || onCompactContext) ? (
                  <div className="context-menu-separator" role="separator" />
                ) : null}
                {onShowUsage ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onShowUsage();
                    }}
                  >
                    <IconGauge size={14} />
                    Usage
                  </button>
                ) : null}
                {onCompactContext ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onCompactContext();
                    }}
                  >
                    <IconConcise size={14} />
                    Compact context
                  </button>
                ) : null}
                {onDelete && (onRename || onMoveToProject || onShowUsage || onCompactContext) ? (
                  <div className="context-menu-separator" role="separator" />
                ) : null}
                {onDelete ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="destructive"
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                  >
                    <IconTrashCan size={14} />
                    Delete session
                  </button>
                ) : null}
                {onOpenTuiDebug ? (
                  <>
                    <div className="context-menu-separator" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      // Debug-only fallback: resume this session in Hermes' raw
                      // TUI to tell a June adapter/UI bug from a Hermes one.
                      title={HERMES_TUI_DEBUG_WARNING}
                      onClick={() => {
                        setMenuOpen(false);
                        onOpenTuiDebug();
                      }}
                    >
                      <IconConsole size={14} />
                      Debug with Hermes TUI
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <Dialog
        open={instructionsOpen}
        onClose={() => setInstructionsOpen(false)}
        title={`${projectContext?.name ?? "Project"} instructions`}
        footer={
          <button
            type="button"
            className="primary-action"
            onClick={() => setInstructionsOpen(false)}
          >
            Close
          </button>
        }
      >
        <div className="agent-project-instructions-content">
          {projectContext?.instructions?.trim() || "No project instructions have been added."}
        </div>
      </Dialog>
    </div>
  );
}

const AGENT_TITLE_MAX_CHARS = 48;

async function agentSessionTitleForPrompt(prompt: string, response?: string) {
  try {
    const suggestion = await withTimeout(
      suggestAgentSessionTitle(prompt, response),
      AGENT_TITLE_TIMEOUT_MS,
    );
    const title = suggestion.title.trim();
    return isAgentSessionTitleCandidate(title)
      ? { title, fromModel: true, rejected: false }
      : { title: titleFromPrompt(prompt), fromModel: false, rejected: true };
  } catch (error) {
    return {
      title: titleFromPrompt(prompt),
      fromModel: false,
      rejected: errorCode(error) === "agent_title_empty",
    };
  }
}

function truncateAgentTitleResponseExcerpt(response: string) {
  return Array.from(response).slice(0, 1200).join("");
}

function isReplaceableAgentSessionTitle(title: unknown) {
  const normalized = safeText(title).trim().toLowerCase();
  return (
    !normalized ||
    normalized === "untitled session" ||
    normalized.endsWith("...") ||
    normalized.length > 52 ||
    /^(?:i'm\s+|i\s+(?:want|need)\s+|please\s+|can you\s+|could you\s+|would you\s+|help me\s+|who are you|what can you|what are you|what do you|summarize\s+|set up\s+|test$)/.test(
      normalized,
    )
  );
}

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

export function SkillsToolsPanel({
  loading,
  query,
  saving,
  skills,
  toolsets,
  onQueryChange,
  onRefresh,
  onToggleSkill,
  onToggleToolset,
  onOpenSkill,
  onSaveSkill,
}: {
  loading: boolean;
  query: string;
  saving: string | null;
  skills: HermesSkillInfo[] | null;
  toolsets: HermesToolsetInfo[] | null;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onToggleSkill: (skill: HermesSkillInfo, enabled: boolean) => void;
  onToggleToolset: (toolset: HermesToolsetInfo, enabled: boolean) => void;
  onOpenSkill?: (skill: HermesSkillInfo) => Promise<HermesSkillDocument>;
  onSaveSkill?: (skill: HermesSkillInfo, content: string) => Promise<HermesSkillDocument>;
}) {
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const [skillDocument, setSkillDocument] = useState<HermesSkillDocument | null>(null);
  const [skillDraft, setSkillDraft] = useState("");
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const q = query.trim().toLowerCase();
  const visibleSkills = (skills ?? [])
    .filter((skill) => capabilityMatches(skill, q))
    .sort((a, b) => safeText(a.name).localeCompare(safeText(b.name)));
  const visibleToolsets = (toolsets ?? [])
    .filter((toolset) => capabilityMatches(toolset, q))
    .sort((a, b) => safeText(a.label ?? a.name).localeCompare(safeText(b.label ?? b.name)));
  const selectedSkill = (skills ?? []).find((skill) => skill.name === selectedSkillName) ?? null;
  const skillDirty = Boolean(skillDocument) && skillDraft !== (skillDocument?.content ?? "");

  async function openSkill(skill: HermesSkillInfo) {
    if (!onOpenSkill) return;
    setSelectedSkillName(skill.name);
    setSkillDocument(null);
    setSkillDraft("");
    setSkillError(null);
    setSkillLoading(true);
    try {
      const document = await onOpenSkill(skill);
      setSkillDocument(document);
      setSkillDraft(document.content);
    } catch (err) {
      setSkillError(messageFromError(err));
    } finally {
      setSkillLoading(false);
    }
  }

  async function saveSkill() {
    if (!selectedSkill || !onSaveSkill || !skillDocument) return;
    setSkillSaving(true);
    setSkillError(null);
    try {
      const document = await onSaveSkill(selectedSkill, skillDraft);
      setSkillDocument(document);
      setSkillDraft(document.content);
    } catch (err) {
      setSkillError(messageFromError(err));
    } finally {
      setSkillSaving(false);
    }
  }

  function closeSkillEditor() {
    setSelectedSkillName(null);
    setSkillDocument(null);
    setSkillDraft("");
    setSkillError(null);
    setDiscardConfirmOpen(false);
  }

  function requestCloseSkillEditor() {
    if (skillDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    closeSkillEditor();
  }

  if (selectedSkillName) {
    return (
      <>
        <SkillEditorPanel
          document={skillDocument}
          dirty={skillDirty}
          error={skillError}
          loading={skillLoading}
          saving={skillSaving}
          skill={selectedSkill}
          value={skillDraft}
          onBack={requestCloseSkillEditor}
          onCancel={requestCloseSkillEditor}
          onChange={setSkillDraft}
          onSave={() => void saveSkill()}
        />
        <ConfirmDialog
          open={discardConfirmOpen}
          title="Discard skill edits?"
          description="Your unsaved changes will be lost."
          confirmLabel="Discard"
          destructive
          onClose={() => setDiscardConfirmOpen(false)}
          onConfirm={closeSkillEditor}
        />
      </>
    );
  }

  return (
    <section className="agent-management-panel" aria-label="Skills and tools">
      <ManagementToolbar
        loading={loading}
        placeholder="Search skills and toolsets"
        query={query}
        onQueryChange={onQueryChange}
        onRefresh={onRefresh}
      />
      {loading && !skills && !toolsets ? (
        <div className="agent-loading">
          <Spinner />
        </div>
      ) : (
        <div className="agent-management-scroll">
          <CapabilityGroup title="Skills" count={visibleSkills.length} empty="No matching skills">
            {visibleSkills.map((skill) => (
              <CapabilityRow
                key={skill.name}
                title={skill.name}
                description={skill.description}
                meta={skill.category}
                enabled={Boolean(skill.enabled)}
                saving={saving === `skill:${skill.name}`}
                onSelect={onOpenSkill ? () => void openSkill(skill) : undefined}
                onToggle={(enabled) => onToggleSkill(skill, enabled)}
              />
            ))}
          </CapabilityGroup>
          <CapabilityGroup
            title="Toolsets"
            count={visibleToolsets.length}
            empty="No matching toolsets"
          >
            {visibleToolsets.map((toolset) => (
              <CapabilityRow
                key={toolset.name}
                title={toolset.label ?? toolset.name}
                description={toolset.description}
                meta={toolset.provider ?? toolNames(toolset).slice(0, 4).join(", ")}
                enabled={Boolean(toolset.enabled)}
                saving={saving === `toolset:${toolset.name}`}
                onToggle={(enabled) => onToggleToolset(toolset, enabled)}
              />
            ))}
          </CapabilityGroup>
        </div>
      )}
    </section>
  );
}

function SkillEditorPanel({
  dirty,
  document,
  error,
  loading,
  saving,
  skill,
  value,
  onBack,
  onCancel,
  onChange,
  onSave,
}: {
  dirty: boolean;
  document: HermesSkillDocument | null;
  error: string | null;
  loading: boolean;
  saving: boolean;
  skill: HermesSkillInfo | null;
  value: string;
  onBack: () => void;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const title = skill?.name ?? document?.name ?? "Skill";
  const readOnly = Boolean(document?.readOnly);
  return (
    <section className="agent-management-panel agent-skill-editor-panel" aria-label={title}>
      <div className="agent-skill-editor">
        <header className="agent-skill-editor-header">
          <button type="button" className="btn btn-ghost agent-skill-editor-back" onClick={onBack}>
            <IconChevronLeftSmall size={15} aria-hidden />
            Skills
          </button>
          <div className="agent-skill-editor-heading">
            <div>
              <h3>{title}</h3>
              {skill?.description ? <p>{skill.description}</p> : null}
            </div>
            <div className="agent-platform-pills">
              {skill?.category ? <span>{skill.category}</span> : null}
              {document?.relativePath ? <span>{document.relativePath}</span> : null}
              {readOnly ? <span>Read-only</span> : null}
              {skill ? <span>{skill.enabled ? "Enabled" : "Disabled"}</span> : null}
            </div>
          </div>
        </header>
        {error ? <p className="settings-row-error">{error}</p> : null}
        {loading ? (
          <div className="agent-loading">
            <Spinner />
          </div>
        ) : (
          <textarea
            className="agent-skill-editor-textarea"
            value={value}
            aria-label={`${title} skill Markdown`}
            disabled={saving}
            readOnly={readOnly}
            spellCheck={false}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        )}
      </div>
      <footer className="agent-messaging-footer">
        {readOnly ? (
          <p className="agent-skill-editor-readonly-note">
            Read-only. This skill loads from ~/.agents/skills. Edit it on disk.
          </p>
        ) : null}
        <button type="button" disabled={saving || loading} onClick={onCancel}>
          Cancel
        </button>
        {readOnly ? null : (
          <button
            type="button"
            className="primary-action primary-solid"
            disabled={!dirty || saving || loading || !document}
            onClick={onSave}
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
        )}
      </footer>
    </section>
  );
}

export function MessagingPanel({
  envEdits,
  loading,
  platforms,
  query,
  saving,
  selectedPlatformId,
  onEditEnv,
  onQueryChange,
  onRefresh,
  onSaveEnv,
  onSelectPlatform,
  onBack,
  onToggle,
}: {
  envEdits: Record<string, string>;
  loading: boolean;
  platforms: HermesMessagingPlatformInfo[] | null;
  query: string;
  saving: string | null;
  selectedPlatformId?: string;
  onEditEnv: (key: string, value: string) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSaveEnv: (platform: HermesMessagingPlatformInfo) => void;
  onSelectPlatform: (platform: HermesMessagingPlatformInfo) => void;
  /** Returns from a platform's configuration to the platform list. */
  onBack?: () => void;
  onToggle: (platform: HermesMessagingPlatformInfo, enabled: boolean) => void;
}) {
  const q = query.trim().toLowerCase();
  const visible = (platforms ?? [])
    .filter((platform) => capabilityMatches(platform, q))
    .sort((a, b) => safeText(a.name).localeCompare(safeText(b.name)));
  // Selection is a drill-in: no platform is open until the user picks one.
  const selected = (platforms ?? []).find((platform) => platform.id === selectedPlatformId) ?? null;

  if (selected) {
    return (
      <section className="agent-management-panel" aria-label="Messaging platforms">
        <div className="agent-platform-topbar">
          <button
            type="button"
            className="icon-button"
            aria-label="Back to messaging platforms"
            onClick={onBack}
          >
            <IconChevronLeftSmall size={14} ariaHidden />
          </button>
          <span className="agent-platform-topbar-title">{selected.name}</span>
        </div>
        <MessagingPlatformDetail
          envEdits={envEdits}
          platform={selected}
          saving={saving}
          onEditEnv={onEditEnv}
          onSaveEnv={onSaveEnv}
          onToggle={onToggle}
        />
      </section>
    );
  }

  return (
    <section className="agent-management-panel" aria-label="Messaging platforms">
      <ManagementToolbar
        loading={loading}
        placeholder="Search messaging platforms"
        query={query}
        onQueryChange={onQueryChange}
        onRefresh={onRefresh}
      />
      {loading && !platforms ? (
        <div className="agent-loading">
          <Spinner />
        </div>
      ) : (
        <div className="agent-messaging-list" aria-label="Messaging channels">
          <CapabilityGroup
            title="Platforms"
            count={visible.length}
            empty="No matching platforms"
            hideTitle
          >
            {visible.map((platform) => {
              const envVars = platform.envVars ?? platform.env_vars ?? [];
              const requiredSet = envVars.filter(
                (field) => field.required && envFieldSet(field),
              ).length;
              const requiredTotal = envVars.filter((field) => field.required).length;
              const state = platform.state ?? "unknown";
              const enabled = Boolean(platform.enabled);
              const configured =
                platform.configured || (requiredTotal > 0 && requiredSet === requiredTotal);
              // The switch already conveys enabled/disabled and the count badge
              // by the name owns the required-field progress, so the meta line
              // keeps only meaningful status (e.g. Connected). The "Not
              // configured" pill by the switch shows only for an enabled but
              // unconfigured platform.
              return (
                <CapabilityRow
                  key={platform.id}
                  title={platform.name}
                  description={platform.description}
                  count={requiredTotal ? `${requiredSet}/${requiredTotal}` : undefined}
                  enabled={enabled}
                  notConfigured={enabled && !configured}
                  selected={false}
                  saving={saving === `messaging:${platform.id}`}
                  onSelect={() => onSelectPlatform(platform)}
                  onToggle={(enabled) => onToggle(platform, enabled)}
                />
              );
            })}
          </CapabilityGroup>
        </div>
      )}
    </section>
  );
}

export function FilesystemPanel({
  loading,
  query,
  snapshot,
  onQueryChange,
  onRefresh,
}: {
  loading: boolean;
  query: string;
  snapshot: HermesFilesystemSnapshot | null;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
}) {
  const q = query.trim().toLowerCase();
  const roots = (snapshot?.roots ?? [])
    .map((root) => ({
      ...root,
      entries: filterFilesystemEntries(root.entries, q),
    }))
    .filter(
      (root) =>
        !q ||
        includesQuery(root.label, q) ||
        includesQuery(root.path, q) ||
        root.entries.length > 0,
    );

  return (
    <section className="agent-management-panel" aria-label="Agent filesystem">
      <ManagementToolbar
        loading={loading}
        placeholder="Search workspace and memory"
        query={query}
        onQueryChange={onQueryChange}
        onRefresh={onRefresh}
      />
      {loading && !snapshot ? (
        <div className="agent-loading">
          <Spinner />
        </div>
      ) : roots.length ? (
        <div className="agent-management-scroll">
          {roots.map((root) => (
            <section key={root.id} className="agent-files-root">
              <header>
                <div>
                  <h3 className="agent-files-root-title">{root.label}</h3>
                  <p>{root.description}</p>
                </div>
                <button
                  type="button"
                  className="agent-files-root-path"
                  title={`Reveal ${root.label} in Finder`}
                  onClick={() => void revealPath(root.path)}
                >
                  <code>{compactPath(root.path)}</code>
                </button>
              </header>
              <div className="agent-files-body">
                {root.entries.length ? (
                  <div className="agent-files-tree">
                    {root.entries.map((entry) => (
                      <FilesystemEntryRow key={entry.path} entry={entry} level={0} />
                    ))}
                  </div>
                ) : (
                  <p className="agent-capability-empty">No visible entries</p>
                )}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="agent-loading">
          <EmptyState
            icon={<IconFolders size={24} />}
            title="No files"
            description="No matching agent files were found."
          />
        </div>
      )}
    </section>
  );
}

function FilesystemEntryRow({ entry, level }: { entry: HermesFilesystemEntry; level: number }) {
  const isDirectory = entry.kind === "directory";
  const children = entry.children ?? [];
  return (
    <div className="agent-files-entry-group">
      <div className="agent-files-entry" style={{ "--agent-file-depth": level } as CSSProperties}>
        <span className="agent-files-entry-icon" aria-hidden="true">
          {isDirectory ? <IconFolder1 size={14} /> : <FileTypeIcon name={entry.name} size={14} />}
        </span>
        <span className="agent-files-entry-name">{entry.name}</span>
        <span className="agent-files-entry-meta">
          {isDirectory ? "Folder" : formatBytes(entry.size)}
          {entry.modifiedAt ? ` · ${relativeDate(entry.modifiedAt)}` : ""}
        </span>
        {/* Reveal-in-Finder: an interactive icon-button shown on row hover/focus
         * that opens the entry's absolute path in the OS file manager. Hidden
         * for any entry the snapshot reports without an absolute path. */}
        {isAbsolutePath(entry.path) ? (
          <button
            type="button"
            className="icon-button agent-files-entry-reveal"
            title="Reveal in Finder"
            aria-label={`Reveal ${entry.name} in Finder`}
            onClick={() => void revealPath(entry.path)}
          >
            <IconFinder size={13} ariaHidden />
          </button>
        ) : null}
      </div>
      {children.length ? (
        <div className="agent-files-children">
          {children.map((child) => (
            <FilesystemEntryRow key={child.path} entry={child} level={level + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MessagingPlatformDetail({
  envEdits,
  platform,
  saving,
  hideFooter,
  onEditEnv,
  onSaveEnv,
  onToggle,
}: {
  envEdits: Record<string, string>;
  platform: HermesMessagingPlatformInfo | null;
  saving: string | null;
  /** When the host renders the Save / enable actions itself (e.g. in the pinned
   * breadcrumb bar of the settings drill-in), suppress this component's own
   * footer so the actions aren't duplicated. */
  hideFooter?: boolean;
  onEditEnv: (key: string, value: string) => void;
  onSaveEnv: (platform: HermesMessagingPlatformInfo) => void;
  onToggle: (platform: HermesMessagingPlatformInfo, enabled: boolean) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  if (!platform) {
    return (
      <div className="agent-messaging-detail">
        <EmptyState
          icon={<IconBubbleWide size={24} />}
          title="No messaging platform"
          description="No matching Hermes messaging platform is available."
        />
      </div>
    );
  }
  const envVars = platform.envVars ?? platform.env_vars ?? [];
  const required = envVars.filter((field) => field.required);
  const recommended = envVars.filter((field) => !field.required && !field.advanced);
  const advanced = envVars.filter((field) => !field.required && field.advanced);
  const hasEdits = Object.values(messagingTrimEdits(envEdits)).length > 0;
  const docsUrl = platform.docsUrl ?? platform.docs_url;
  const isSavingEnv = saving === `env:${platform.id}`;

  return (
    <div className="agent-messaging-detail">
      <div className="agent-messaging-detail-scroll">
        <header className="agent-messaging-detail-header">
          <h3>{platform.name}</h3>
          <p>{platform.description}</p>
          {docsUrl ? (
            <a className="agent-platform-docs" href={docsUrl} rel="noreferrer" target="_blank">
              Setup guide
              <IconArrowUpRight size={12} ariaHidden />
            </a>
          ) : null}
          <div className="agent-platform-pills">
            <span>{stateLabel(platform.state ?? "unknown")}</span>
            <span>{platform.configured ? "Credentials set" : "Needs setup"}</span>
            {platform.gatewayRunning || platform.gateway_running ? null : (
              <span>Messaging gateway stopped</span>
            )}
          </div>
        </header>
        {platform.errorMessage || platform.error_message ? (
          <div className="agent-platform-error">
            {platform.errorMessage ?? platform.error_message}
          </div>
        ) : null}
        <MessagingFieldGroup
          title="Required"
          fields={required}
          edits={envEdits}
          saving={saving}
          onEditEnv={onEditEnv}
        />
        <MessagingFieldGroup
          title="Recommended"
          fields={recommended}
          edits={envEdits}
          saving={saving}
          onEditEnv={onEditEnv}
        />
        {advanced.length ? (
          <section className="agent-messaging-fields">
            <button
              type="button"
              className="agent-advanced-toggle"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((value) => !value)}
            >
              <span>Advanced</span>
              <span className="status-pill">{advanced.length}</span>
              <IconChevronDownSmall
                size={14}
                aria-hidden
                className="agent-advanced-toggle-chevron"
                data-open={showAdvanced || undefined}
              />
            </button>
            {showAdvanced ? (
              <MessagingFieldGroup
                title=""
                fields={advanced}
                edits={envEdits}
                saving={saving}
                onEditEnv={onEditEnv}
              />
            ) : null}
          </section>
        ) : null}
      </div>
      {hideFooter ? null : (
        <footer className="agent-messaging-footer">
          <button
            type="button"
            className="agent-messaging-enable"
            disabled={saving === `messaging:${platform.id}`}
            onClick={() => onToggle(platform, !platform.enabled)}
          >
            {platform.enabled ? "Enabled" : "Disabled"}
          </button>
          <button
            type="button"
            disabled={!hasEdits || isSavingEnv}
            onClick={() => onSaveEnv(platform)}
          >
            {isSavingEnv ? "Saving..." : "Save changes"}
          </button>
        </footer>
      )}
    </div>
  );
}

export function MessagingFieldGroup({
  edits,
  fields,
  saving,
  title,
  onEditEnv,
}: {
  edits: Record<string, string>;
  fields: HermesMessagingEnvVarInfo[];
  saving: string | null;
  title: string;
  onEditEnv: (key: string, value: string) => void;
}) {
  if (!fields.length) {
    return null;
  }
  return (
    <section className="agent-messaging-fields">
      {title ? <h4>{title}</h4> : null}
      {fields.map((field) => (
        <label key={field.key} className="agent-messaging-field">
          <span>
            {fieldLabel(field)}
            {envFieldSet(field) ? <strong>Saved</strong> : null}
          </span>
          <input
            type={field.isPassword || field.is_password ? "password" : "text"}
            value={edits[field.key] ?? ""}
            disabled={saving === `env:${field.key}`}
            placeholder={
              envFieldSet(field)
                ? (field.redactedValue ?? field.redacted_value ?? "Replace current value")
                : (field.prompt ?? field.key)
            }
            onChange={(event) => onEditEnv(field.key, event.currentTarget.value)}
          />
          {field.description ? <small>{field.description}</small> : null}
        </label>
      ))}
    </section>
  );
}

function ManagementToolbar({
  loading,
  placeholder,
  query,
  onQueryChange,
  onRefresh,
}: {
  loading: boolean;
  placeholder: string;
  query: string;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
}) {
  const [refreshSpins, setRefreshSpins] = useState(0);
  return (
    <div className="agent-management-toolbar">
      <label className="agent-management-search">
        <IconMagnifyingGlass size={15} aria-hidden className="agent-management-search-icon" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </label>
      <button
        type="button"
        className="icon-button agent-management-refresh"
        aria-label="Refresh"
        aria-busy={loading}
        title="Refresh"
        disabled={loading}
        onClick={() => {
          setRefreshSpins((spins) => spins + 1);
          onRefresh();
        }}
      >
        <IconArrowRotateClockwise
          size={14}
          className="balance-refresh-icon"
          style={{ transform: `rotate(${refreshSpins * 360}deg)` }}
        />
      </button>
    </div>
  );
}

function CapabilityGroup({
  children,
  count,
  empty,
  title,
  hideTitle = false,
}: {
  children: ReactNode;
  count: number;
  empty: string;
  title: string;
  /** Hides the in-list heading when the group's title lives above the card as
   * the group heading (the messaging platforms group). */
  hideTitle?: boolean;
}) {
  return (
    <section className="agent-capability-group">
      {hideTitle ? null : (
        <h3>
          {title} <span>{count}</span>
        </h3>
      )}
      {count ? children : <p className="agent-capability-empty">{empty}</p>}
    </section>
  );
}

function CapabilityRow({
  children,
  count,
  description,
  enabled,
  meta,
  notConfigured = false,
  saving,
  selected = false,
  title,
  onSelect,
  onToggle,
}: {
  children?: ReactNode;
  /** A quiet count badge beside the name (e.g. "0/2" required fields set),
   * using the same muted number-badge treatment as the group count. */
  count?: string;
  description?: string;
  enabled: boolean;
  meta?: string;
  /** When true a quiet "Not configured" status pill sits to the left of the
   * switch, flagging that the platform still needs its credentials. */
  notConfigured?: boolean;
  saving: boolean;
  selected?: boolean;
  title: string;
  onSelect?: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <article className="agent-capability-row" data-selected={selected} data-clickable={!!onSelect}>
      <button type="button" disabled={!onSelect} onClick={onSelect}>
        <div className="agent-capability-title">
          <span>{title}</span>
          {count ? <span className="status-pill agent-capability-count">{count}</span> : null}
          {meta ? <em>{meta}</em> : null}
        </div>
        {description ? <p>{description}</p> : null}
        {children}
      </button>
      <div className="agent-capability-actions">
        {notConfigured ? (
          <span className="status-pill agent-capability-status">Not configured</span>
        ) : null}
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={onToggle}
          aria-label={`${enabled ? "Disable" : "Enable"} ${title}`}
        />
        {onSelect ? (
          <IconChevronRightSmall size={14} aria-hidden className="agent-capability-chevron" />
        ) : null}
      </div>
    </article>
  );
}

// Sums turn/part counts plus streamed text lengths so the auto-scroll effect
// re-fires as streamed output grows, not only when a whole turn is added.
function chatTurnsSignature(turns: AgentChatTurn[]) {
  return turns.reduce(
    (total, turn) =>
      total +
      1 +
      turn.parts.reduce(
        (size, part) =>
          size + 1 + ("text" in part && typeof part.text === "string" ? part.text.length : 0),
        0,
      ),
    0,
  );
}

// Deliberate-tooltip delay for the icon-only turn actions, matching the tab
// bar's shortcut tips — slower than the shared hover-intent debounce so
// sweeping across the row doesn't pop a trail of labels.
const TURN_ACTION_TIP_DELAY_MS = 550;

const AGENT_TRANSCRIPT_BOTTOM_THRESHOLD_PX = 48;

export function agentComposerClearance(scrollerBottom: number, composerTop: number) {
  return Math.max(0, Math.ceil(scrollerBottom - composerTop));
}

function isAgentTranscriptNearBottom(scroller: HTMLElement) {
  return (
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
    AGENT_TRANSCRIPT_BOTTOM_THRESHOLD_PX
  );
}

// Self-contained so scroll-driven visibility never re-renders the huge
// AgentWorkspace: only this leaf flips on its own scroll + resize signals.
// While the reader is parked up-thread, streamed turns grow the content
// WITHOUT firing a scroll event, so the ResizeObserver watches the content
// column (not just the scroller) to catch that growth.
export function AgentScrollToLatestButton({
  scrollRef,
  onJump,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  onJump: () => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const recheck = () => {
      const nothingToScroll = scroller.scrollHeight <= scroller.clientHeight;
      const next = !nothingToScroll && !isAgentTranscriptNearBottom(scroller);
      setVisible((current) => (current === next ? current : next));
    };
    recheck();
    scroller.addEventListener("scroll", recheck, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(recheck) : undefined;
    observer?.observe(scroller);
    // The scroller box itself never resizes when content grows (fixed height,
    // overflow scroll), so watch its children — all of them, not a presumed
    // single content column — since their growth is what moves scrollHeight.
    for (const child of Array.from(scroller.children)) observer?.observe(child);
    return () => {
      scroller.removeEventListener("scroll", recheck);
      observer?.disconnect();
    };
  }, [scrollRef]);

  return (
    <button
      type="button"
      className="agent-scroll-to-latest"
      data-visible={visible ? "true" : undefined}
      aria-label="Scroll to latest"
      aria-hidden={visible ? undefined : true}
      tabIndex={visible ? undefined : -1}
      onClick={onJump}
    >
      <IconArrowDown size={16} ariaHidden />
    </button>
  );
}

// Collapse runs of "thinking-only" assistant turns (reasoning/tool, no answer
// text) into the next answer turn, so a back-to-back chain of thoughts shows as
// a single "Thought" disclosure rather than several stacked in a row.
function mergeThinkingTurns(turns: AgentChatTurn[]): AgentChatTurn[] {
  const isThinkingOnly = (turn: AgentChatTurn): boolean =>
    turn.role === "assistant" &&
    turn.parts.length > 0 &&
    turn.parts.every((part) => part.type === "reasoning" || part.type === "tool");
  const rebuild = (turn: AgentChatTurn, parts: AgentChatPart[]): AgentChatTurn => ({
    id: turn.id,
    branchMessageId: turn.branchMessageId,
    role: turn.role,
    createdAt: turn.createdAt,
    status: turn.status,
    parts,
  });

  const out: AgentChatTurn[] = [];
  let pending: AgentChatTurn | undefined;
  for (const turn of turns) {
    if (isThinkingOnly(turn)) {
      pending = pending === undefined ? turn : rebuild(turn, [...pending.parts, ...turn.parts]);
      continue;
    }
    if (turn.role === "assistant" && pending !== undefined) {
      out.push(rebuild(turn, [...pending.parts, ...turn.parts]));
      pending = undefined;
      continue;
    }
    if (pending !== undefined) {
      out.push(pending);
      pending = undefined;
    }
    out.push(turn);
  }
  if (pending !== undefined) out.push(pending);
  return out;
}

// Dev-only catalog of every agent response part type, rendered through the real
// <AgentChatTurnRow> so the styling shown is exactly what ships. Toggled from the
// console via window.__agentGallery(). Handlers are no-ops — it's a static
// styling reference, not a live conversation. Module-level so the reference is
// stable across renders.
const galleryNoop = () => {};

const SHIMMER_GALLERY_SAMPLES = [
  { length: "Short", text: "Thinking…" },
  { length: "Medium", text: "Generating image…" },
  { length: "Long", text: "Generating video, this can take a minute" },
] as const;

function AgentShimmerGallerySection() {
  return (
    <section className="agent-gallery-section agent-gallery-shimmer-section">
      <header className="agent-gallery-section-header">
        <h3>Shimmer text lengths</h3>
        <p>
          Each sample uses the production color, spread, and 1.6-second cadence. Compare perceived
          speed and contrast across text lengths in the active theme.
        </p>
      </header>
      <dl className="agent-gallery-shimmer-list">
        {SHIMMER_GALLERY_SAMPLES.map((sample) => (
          <div key={sample.length} className="agent-gallery-shimmer-sample">
            <dt>{sample.length}</dt>
            <dd>
              <span className="text-shimmer shimmer agent-gallery-shimmer-text">{sample.text}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function AgentResponseGallery({
  sections,
  errors,
  fundingTier,
  onClose,
}: {
  sections: AgentChatGallerySection[];
  errors?: boolean;
  fundingTier?: FundingTier;
  onClose: () => void;
}) {
  const [thinkingOpenByKey, setThinkingOpenByKey] = useState<Record<string, boolean>>({});
  const [upstreamFailureRetryAttempts, setUpstreamFailureRetryAttempts] = useState<
    Record<string, true>
  >({});
  const setThinkingOpen = useCallback((key: string, open: boolean) => {
    setThinkingOpenByKey((current) =>
      current[key] === open ? current : { ...current, [key]: open },
    );
  }, []);
  return (
    <div className="agent-timeline agent-gallery">
      <div className="agent-gallery-banner">
        <div>
          <strong>{errors ? "Agent error gallery" : "Agent response gallery"}</strong>
          <p>
            {errors
              ? "Every error surface in agent chat. The banner above and the composer notice below are forced samples too."
              : "Every response part type and status, for styling."}{" "}
            Close from the console with{" "}
            <code>{errors ? "__agentErrors" : "__agentGallery"}(false)</code>.
          </p>
        </div>
        <button
          type="button"
          className="agent-icon-button"
          aria-label="Close gallery"
          onClick={onClose}
        >
          <IconCrossMedium size={15} />
        </button>
      </div>
      {errors ? null : <AgentShimmerGallerySection />}
      {sections.map((section) => (
        <section key={section.label} className="agent-gallery-section">
          <header className="agent-gallery-section-header">
            <h3>{section.label}</h3>
            {section.description ? <p>{section.description}</p> : null}
          </header>
          {section.turns.map((turn) => (
            <AgentChatTurnRow
              key={turn.id}
              turn={turn}
              artifacts={section.artifacts}
              approvalSubmitting={{}}
              approvalScopeId="gallery"
              clarifySubmitting={{}}
              sudoSubmitting={{}}
              secretSubmitting={{}}
              thinkingOpen={(key) => thinkingOpenByKey[key] ?? false}
              onApproval={galleryNoop}
              onClarify={galleryNoop}
              onSudo={galleryNoop}
              onSecret={galleryNoop}
              onDownloadArtifact={galleryNoop}
              onRetryUpstreamFailure={(turnId) =>
                setUpstreamFailureRetryAttempts((current) => ({ ...current, [turnId]: true }))
              }
              upstreamFailureRetryAttempted={Boolean(upstreamFailureRetryAttempts[turn.id])}
              onThinkingOpenChange={setThinkingOpen}
              onTopUp={galleryNoop}
              fundingTier={fundingTier}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function AgentChatTurnRow({
  activeThinkingKey,
  approvalSubmitting,
  approvalScopeId,
  artifacts,
  clarifySubmitting,
  sudoSubmitting,
  secretSubmitting,
  cliAccess,
  browserAccess,
  thinkingOpen,
  onApproval,
  onClarify,
  onSudo,
  onSecret,
  onDownloadArtifact,
  onOpenArtifact,
  onDownloadImage,
  onOpenImage,
  onRetryImage,
  onDownloadVideo,
  onRetryVideo,
  onRetryUpstreamFailure,
  upstreamFailureRetryAttempted,
  upstreamFailureRetryDisabled,
  creditActionsDisabledReason,
  onThinkingOpenChange,
  onTopUp,
  topUpLabel,
  fundingTier,
  onVisibleMarkdownChange,
  onBranch,
  branchingMessageId,
  turn,
}: {
  activeThinkingKey?: string;
  approvalSubmitting: Partial<Record<string, AgentApprovalChoice>>;
  approvalScopeId: string;
  artifacts?: AgentArtifact[];
  clarifySubmitting: Record<string, string>;
  sudoSubmitting: Record<string, "approve" | "deny">;
  secretSubmitting: Record<string, true>;
  /** State + handler for June's in-chat Agent CLI access request card.
   * Optional so the dev gallery can render rows without the live setting. */
  cliAccess?: AgentCliAccessCardProps;
  /** State + handler for June's in-chat Browser use request card. Optional
   * for the same reason. */
  browserAccess?: AgentBrowserAccessCardProps;
  thinkingOpen: (key: string) => boolean;
  onApproval: (
    part: Extract<AgentChatPart, { type: "approval" }>,
    choice: AgentApprovalChoice,
  ) => void;
  onClarify: (part: Extract<AgentChatPart, { type: "clarify" }>, answer: string) => void;
  onSudo: (part: Extract<AgentChatPart, { type: "sudo" }>, approved: boolean) => void;
  onSecret: (part: Extract<AgentChatPart, { type: "secret" }>, value: string) => void;
  onDownloadArtifact?: (artifact: AgentArtifact) => void;
  onOpenArtifact?: (artifact: AgentArtifact) => void;
  /** Save a `/image` result to disk; enlarge it in the file viewer. Optional so
   * the dev gallery can render image rows without the live bridge. */
  onDownloadImage?: (part: Extract<AgentChatPart, { type: "image" }>) => void;
  onOpenImage?: (part: Extract<AgentChatPart, { type: "image" }>) => void;
  onRetryImage?: (assistantTurnId: string, part: Extract<AgentChatPart, { type: "image" }>) => void;
  onDownloadVideo?: (part: Extract<AgentChatPart, { type: "video" }>) => void;
  onRetryVideo?: (assistantTurnId: string, part: Extract<AgentChatPart, { type: "video" }>) => void;
  onRetryUpstreamFailure?: (assistantTurnId: string) => void;
  upstreamFailureRetryAttempted?: boolean;
  upstreamFailureRetryDisabled?: boolean;
  creditActionsDisabledReason?: string;
  onThinkingOpenChange: (key: string, open: boolean) => void;
  onTopUp?: () => void;
  topUpLabel?: string;
  fundingTier?: FundingTier;
  onVisibleMarkdownChange?: (visibleMarkdown: string) => void;
  /** Fork the conversation from this turn into a new session (feature 07).
   * Optional: only Hermes-session rows pass it — task rows and the dev gallery
   * omit it, so the action is absent there. */
  onBranch?: (messageId: string, sessionId?: string) => void;
  /** The message id a branch is currently in flight for, so its action shows a
   * working/disabled state. */
  branchingMessageId?: string | null;
  turn: AgentChatTurn;
}) {
  const textParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "text" }> => part.type === "text",
  );
  const reasoningParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "reasoning" }> => part.type === "reasoning",
  );
  const toolParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "tool" }> => part.type === "tool",
  );
  const hasGeneratedImage = turn.parts.some((part) => part.type === "image");
  const hasGeneratedVideo = turn.parts.some((part) => part.type === "video");
  // The media canvas owns successful generation from start through result.
  // Keeping the generic tool row alongside it would show two activity states,
  // then make that row pop back in above the finished media. Failed media tools
  // and unrelated tools still render normally.
  const visibleToolParts = toolParts.filter((part) => {
    if (!part.media || part.status === "failed") return true;
    if (part.status === "running") return false;
    return part.media === "image" ? !hasGeneratedImage : !hasGeneratedVideo;
  });
  type ReasoningPart = Extract<AgentChatPart, { type: "reasoning" }>;
  type ReasoningRun = { key: string; parts: ReasoningPart[] };
  const reasoningRuns: ReasoningRun[] = [];
  const reasoningRunByFirstPart = new Map<ReasoningPart, ReasoningRun>();
  let currentReasoningRun: ReasoningRun | undefined;
  for (const [index, part] of turn.parts.entries()) {
    if (part.type !== "reasoning") {
      currentReasoningRun = undefined;
      continue;
    }
    if (!currentReasoningRun) {
      currentReasoningRun = {
        key: `turn:${turn.id}:thinking:${part.renderKey ?? index}`,
        parts: [],
      };
      reasoningRuns.push(currentReasoningRun);
      reasoningRunByFirstPart.set(part, currentReasoningRun);
    }
    currentReasoningRun.parts.push(part);
  }
  type ToolPart = Extract<AgentChatPart, { type: "tool" }>;
  type ToolRun = { key: string; parts: ToolPart[] };
  const visibleToolPartSet = new Set(visibleToolParts);
  const toolRunByFirstPart = new Map<ToolPart, ToolRun>();
  let currentToolRun: ToolRun | undefined;
  for (const part of turn.parts) {
    if (part.type !== "tool" || !visibleToolPartSet.has(part)) {
      currentToolRun = undefined;
      continue;
    }
    if (!currentToolRun) {
      currentToolRun = { key: `${turn.id}:tool-stack:${part.id}`, parts: [] };
      toolRunByFirstPart.set(part, currentToolRun);
    }
    currentToolRun.parts.push(part);
  }
  // The disclosure owns internal reasoning only. Tool/action rows stay visible
  // outside it so users can see what June is doing without expanding Thought;
  // a running media tool is represented by its canvas instead, just above.
  const thinkingRunning = reasoningParts.some((part) => part.status === "running");
  const latestReasoningRun = reasoningRuns.at(-1);
  const completedThinkingKey = latestReasoningRun?.key ?? `turn:${turn.id}:thinking`;
  const wasThinkingRunningRef = useRef(thinkingRunning);
  const carriedOpen =
    !thinkingRunning &&
    wasThinkingRunningRef.current &&
    activeThinkingKey !== undefined &&
    thinkingOpen(activeThinkingKey);
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const wasRunning = wasThinkingRunningRef.current;
    wasThinkingRunningRef.current = thinkingRunning;
    if (
      !wasRunning ||
      thinkingRunning ||
      activeThinkingKey === undefined ||
      reasoningParts.length === 0 ||
      !thinkingOpen(activeThinkingKey)
    ) {
      return;
    }
    onThinkingOpenChange(completedThinkingKey, true);
    onThinkingOpenChange(activeThinkingKey, false);
  }, [
    activeThinkingKey,
    completedThinkingKey,
    onThinkingOpenChange,
    reasoningParts.length,
    thinkingOpen,
    thinkingRunning,
    toolParts.length,
  ]);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  const contextParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "context" }> => part.type === "context",
  );
  const attachmentParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "attachment" }> => part.type === "attachment",
  );
  const nonTextParts = turn.parts.filter((part) => part.type !== "text");
  const holdTrailingMediaTransport = turnContainsMediaStructure(turn);
  const concreteResponse = turnIsConcreteResponse(turn);
  const copyText = copyableTextForTurn(turn);

  async function copyTurn() {
    if (!copyText) return;
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimerRef.current = undefined;
      }, 1600);
    } catch {
      // Clipboard can fail in restricted contexts; leave the transcript alone.
    }
  }

  // Per-turn transcript actions. Branch is rendered only on Hermes-session rows
  // (which pass `onBranch`); pending user prompts and live assistant rows route
  // to the nearest saved fork point, while other synthetic rows still explain
  // that they need to be saved first.
  const branchSessionId = branchSourceSessionIdForTurn(turn);
  const branchMessageId =
    turn.branchMessageId ??
    (turn.role === "assistant" && !isLiveAssistantTurnId(turn.id)
      ? `assistant:${turn.id}`
      : turn.id);
  const branchSubmitting = branchingMessageId === branchMessageId;
  const branchAction = onBranch ? (
    <BranchFromHereAction
      messageId={branchMessageId}
      sessionId={branchSessionId}
      onBranch={onBranch}
      submitting={branchSubmitting}
    />
  ) : null;
  const copyAction = copyText ? (
    <HoverTip
      compact
      width={104}
      delay={TURN_ACTION_TIP_DELAY_MS}
      tip={copied ? "Copied" : "Copy message"}
      forceOpen={copied}
      className="agent-turn-action-tip"
    >
      <button
        type="button"
        className="agent-turn-action"
        aria-label={copied ? "Copied message" : "Copy message"}
        data-copied={copied ? "true" : undefined}
        onClick={() => void copyTurn()}
      >
        <CopyStateIcon copied={copied} />
      </button>
    </HoverTip>
  ) : null;
  // Timestamp for the row. relativeDate returns "" for an unparseable value, so
  // we only render the <time> when there's a real date to show.
  const timestampLabel = relativeDate(turn.createdAt);
  const timestampAction = timestampLabel ? (
    <HoverTip
      compact
      width={200}
      delay={TURN_ACTION_TIP_DELAY_MS}
      tip={new Date(turn.createdAt).toLocaleString()}
      className="agent-turn-action-tip"
    >
      <time className="agent-turn-timestamp" dateTime={turn.createdAt}>
        {timestampLabel}
      </time>
    </HoverTip>
  ) : null;
  const turnActions =
    concreteResponse && (copyAction || branchAction || timestampAction) ? (
      <div className="agent-turn-actions" data-branching={branchSubmitting ? "true" : undefined}>
        <div className="agent-turn-actions-inner">
          {/* The timestamp sits on the outer/far side of the row: before the
           * icons on right-aligned user turns, after them on left-aligned
           * assistant turns, so the icons always stay nearest the message. */}
          {turn.role === "user" ? timestampAction : null}
          {copyAction}
          {branchAction}
          {turn.role === "user" ? null : timestampAction}
        </div>
      </div>
    ) : null;

  if (contextParts.length && turn.parts.every((part) => part.type === "context")) {
    return (
      <>
        {contextParts.map((part, index) => (
          <ContextCompactionPart key={`${turn.id}:context:${index}`} part={part} />
        ))}
      </>
    );
  }

  if (turn.role === "user") {
    return (
      <article
        className="agent-user-turn"
        data-scheduled-run={turn.isScheduledRun ? "true" : undefined}
      >
        {turn.isScheduledRun ? (
          <span className="agent-user-turn-eyebrow">
            <IconArrowsRepeat size={12} aria-hidden />
            Scheduled routine run
          </span>
        ) : null}
        <div className="agent-user-turn-body">
          {textParts.map((part, index) => {
            const markdown = displayedComposerUserMessageText(part.text);
            return markdown ? (
              <MarkdownContent
                key={`${turn.id}:text:${index}`}
                // Issue-report sessions open with the wrapped investigation
                // prompt; the transcript shows only what the user typed.
                markdown={markdown}
              />
            ) : null;
          })}
          {attachmentParts.length ? (
            <AgentUserAttachmentList attachments={attachmentParts} onOpen={onOpenArtifact} />
          ) : null}
        </div>
        {turnActions}
      </article>
    );
  }

  return (
    <article className="agent-assistant-turn" data-status={turn.status}>
      <div className="agent-assistant-turn-body">
        {turn.parts.map((part, index) =>
          part.type === "text" ? (
            hasAgentCliAccessRequest(part.text) || hasBrowserAccessRequest(part.text) ? (
              // June's soul emits a literal token to request the Agent CLI
              // access or Browser use setting; each token renders as an
              // approval card, never as text. A reply carrying both tokens
              // gets both cards.
              <div key={part.renderKey ?? `${turn.id}:text:${index}`}>
                {stripBrowserAccessRequest(stripAgentCliAccessRequest(part.text)) ? (
                  <MarkdownContent
                    markdown={stripBrowserAccessRequest(stripAgentCliAccessRequest(part.text))}
                    repairProse
                  />
                ) : null}
                {hasAgentCliAccessRequest(part.text) ? (
                  <AgentCliAccessCard cliAccess={cliAccess} />
                ) : null}
                {hasBrowserAccessRequest(part.text) ? (
                  <AgentBrowserAccessCard browserAccess={browserAccess} />
                ) : null}
              </div>
            ) : (
              <div key={part.renderKey ?? `${turn.id}:text:${index}`}>
                {/* A part can retain raw MEDIA deltas while streaming or when
                    a terminal/error event arrives without message.complete.
                    Those transport references never belong in assistant prose. */}
                <SmoothedStreamingMarkdown
                  markdown={stripRenderedMediaReferences(
                    part.text,
                    part.status === "running" || holdTrailingMediaTransport,
                  )}
                  running={part.status === "running"}
                  repairProse
                  onVisibleMarkdownChange={onVisibleMarkdownChange}
                />
              </div>
            )
          ) : part.type === "reasoning" ? (
            reasoningRunByFirstPart.has(part) ? (
              <AgentThinkingGroup
                key={reasoningRunByFirstPart.get(part)?.key}
                reasoning={reasoningRunByFirstPart.get(part)?.parts ?? []}
                running={
                  reasoningRunByFirstPart.get(part) === latestReasoningRun && thinkingRunning
                }
                open={
                  thinkingOpen(
                    reasoningRunByFirstPart.get(part) === latestReasoningRun &&
                      thinkingRunning &&
                      activeThinkingKey
                      ? activeThinkingKey
                      : (reasoningRunByFirstPart.get(part)?.key ?? completedThinkingKey),
                  ) ||
                  (reasoningRunByFirstPart.get(part) === latestReasoningRun && carriedOpen)
                }
                onOpenChange={(open) =>
                  onThinkingOpenChange(
                    reasoningRunByFirstPart.get(part) === latestReasoningRun &&
                      thinkingRunning &&
                      activeThinkingKey
                      ? activeThinkingKey
                      : (reasoningRunByFirstPart.get(part)?.key ?? completedThinkingKey),
                    open,
                  )
                }
              />
            ) : null
          ) : part.type === "tool" ? (
            part.status === "running" && part.media === "image" ? (
              <AgentGeneratedImage
                key={`generating:${part.id}`}
                part={{ type: "image", status: "running", prompt: "" }}
              />
            ) : part.status === "running" && part.media === "video" ? (
              <AgentGeneratedVideo
                key={`generating:${part.id}`}
                part={{ type: "video", status: "running", prompt: "" }}
              />
            ) : toolRunByFirstPart.has(part) ? (
              <AgentToolStack
                key={toolRunByFirstPart.get(part)?.key}
                parts={toolRunByFirstPart.get(part)?.parts ?? []}
              />
            ) : null
          ) : part.type === "context" ? (
            <ContextCompactionPart key={`${turn.id}:context:${index}`} part={part} />
          ) : part.type === "approval" ? (
            <ApprovalPart
              key={`${turn.id}:approval:${part.instanceId ?? part.id}`}
              part={part}
              submitting={
                approvalSubmitting[approvalResponseKey(approvalScopeId, part.instanceId ?? part.id)]
              }
              onApproval={onApproval}
            />
          ) : part.type === "clarify" ? (
            <ClarifyPart
              key={`${turn.id}:clarify:${part.id}`}
              part={part}
              submitting={clarifySubmitting[part.id]}
              onClarify={onClarify}
            />
          ) : part.type === "sudo" ? (
            <SudoPart
              key={`${turn.id}:sudo:${part.id}`}
              part={part}
              submitting={sudoSubmitting[part.id]}
              onSudo={onSudo}
            />
          ) : part.type === "secret" ? (
            <SecretPart
              key={`${turn.id}:secret:${part.id}`}
              part={part}
              submitting={secretSubmitting[part.id]}
              onSecret={onSecret}
            />
          ) : part.type === "notice" ? (
            part.kind === "context-overflow" ? (
              <ContextOverflowNoticePart key={`${turn.id}:notice:${index}`} />
            ) : part.kind === "upstream-provider" ? (
              <UpstreamProviderFailureNoticePart
                key={`${turn.id}:notice:${index}`}
                attempted={upstreamFailureRetryAttempted}
                disabled={upstreamFailureRetryDisabled}
                onRetry={onRetryUpstreamFailure ? () => onRetryUpstreamFailure(turn.id) : undefined}
              />
            ) : (
              <CreditsNoticePart
                key={`${turn.id}:notice:${index}`}
                onTopUp={onTopUp}
                topUpLabel={topUpLabel}
                tier={fundingTier}
              />
            )
          ) : part.type === "steering" ? (
            <SteeringPart key={`${turn.id}:steering:${index}`} part={part} />
          ) : part.type === "image" ? (
            <AgentGeneratedImage
              key={`${turn.id}:image:${index}`}
              part={part}
              onOpen={onOpenImage}
              onDownload={onDownloadImage}
              onRetry={onRetryImage ? () => onRetryImage(turn.id, part) : undefined}
            />
          ) : part.type === "video" ? (
            <AgentGeneratedVideo
              key={`${turn.id}:video:${index}`}
              part={part}
              onDownload={onDownloadVideo}
              onRetry={onRetryVideo ? () => onRetryVideo(turn.id, part) : undefined}
              retryDisabledReason={part.jobId ? undefined : creditActionsDisabledReason}
            />
          ) : null,
        )}
        <AgentArtifactList
          artifacts={artifacts ?? []}
          onDownload={onDownloadArtifact}
          onOpen={onOpenArtifact}
        />
        {textParts.length === 0 && nonTextParts.length === 0 ? (
          <p className="agent-assistant-empty">
            <span className="text-shimmer shimmer">Thinking…</span>
          </p>
        ) : (
          // No actions on an empty/in-flight turn. There is nothing useful to
          // copy or fork from yet.
          turnActions
        )}
      </div>
    </article>
  );
}

function AgentUserAttachmentList({
  attachments,
  onOpen,
}: {
  attachments: Extract<AgentChatPart, { type: "attachment" }>[];
  onOpen?: (artifact: AgentArtifact) => void;
}) {
  return (
    <div className="agent-user-attachments" role="group" aria-label="Attachments">
      {attachments.map((attachment) => (
        <AgentUserAttachment key={attachment.path} attachment={attachment} onOpen={onOpen} />
      ))}
    </div>
  );
}

function AgentUserAttachment({
  attachment,
  onOpen,
}: {
  attachment: Extract<AgentChatPart, { type: "attachment" }>;
  onOpen?: (artifact: AgentArtifact) => void;
}) {
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (attachment.kind !== "image") return;
    let cancelled = false;
    hermesBridgeFilePreview(attachment.path)
      .then((dataUrl) => {
        if (!cancelled) setPreviewDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setPreviewDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.kind, attachment.path]);

  const artifact: AgentArtifact = {
    name: attachment.name,
    path: attachment.path,
    rootLabel: "Workspace",
  };
  const content =
    attachment.kind === "image" ? (
      previewDataUrl ? (
        <img src={previewDataUrl} alt="" aria-hidden="true" draggable={false} />
      ) : previewDataUrl === undefined ? (
        <span className="agent-user-attachment-loading text-shimmer shimmer">Loading image...</span>
      ) : (
        <>
          <span className="agent-attachment-file-icon" aria-hidden="true">
            <FileTypeIcon name={attachment.name} size={18} />
          </span>
          <span className="agent-user-attachment-name">{attachment.name}</span>
        </>
      )
    ) : (
      <>
        <span className="agent-attachment-file-icon" aria-hidden="true">
          <FileTypeIcon name={attachment.name} size={18} />
        </span>
        <span className="agent-user-attachment-name">{attachment.name}</span>
      </>
    );

  return onOpen ? (
    <button
      type="button"
      className="agent-user-attachment"
      data-kind={attachment.kind}
      aria-label={`Open ${attachment.name}`}
      title={attachment.name}
      onClick={() => onOpen(artifact)}
    >
      {content}
    </button>
  ) : (
    <div className="agent-user-attachment" data-kind={attachment.kind} title={attachment.name}>
      {content}
    </div>
  );
}

function copyableTextForTurn(turn: AgentChatTurn): string {
  if (turn.role === "user") return userPromptTextForTurn(turn);
  if (turn.role !== "assistant") return "";
  const holdTrailingMediaTransport = turnContainsMediaStructure(turn);
  return turn.parts
    .filter((part): part is Extract<AgentChatPart, { type: "text" }> => part.type === "text")
    .map((part) =>
      stripBrowserAccessRequest(
        stripAgentCliAccessRequest(
          stripRenderedMediaReferences(part.text, holdTrailingMediaTransport),
        ),
      ).trim(),
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function turnContainsMediaStructure(turn: Pick<AgentChatTurn, "parts">) {
  return turn.parts.some(
    (part) =>
      part.type === "image" ||
      part.type === "video" ||
      (part.type === "tool" && part.media !== undefined),
  );
}

function userPromptTextForTurn(turn: AgentChatTurn): string {
  return turn.parts
    .filter((part): part is Extract<AgentChatPart, { type: "text" }> => part.type === "text")
    .map((part) => displayedComposerUserMessageText(part.text).trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function ContextCompactionPart({ part }: { part: Extract<AgentChatPart, { type: "context" }> }) {
  return (
    <details className="agent-context-summary">
      <summary>
        {/* Same hover affordance as the tool rows: the glyph cross-fades to a
         * plain-text "+"/"−" so the row reads as one quiet, expandable line.
         * IconConcise (thinned via CSS) marks the squeeze of compaction. No
         * timestamp: this is a system marker, not a concrete message. */}
        <span className="agent-tool-icon">
          <IconConcise size={15} className="agent-context-icon-glyph" />
          <span className="agent-tool-icon-expand">+</span>
          <span className="agent-tool-icon-minimize">−</span>
        </span>
        <span className="agent-context-label">Context compacted</span>
      </summary>
      <MarkdownContent markdown={part.text} />
    </details>
  );
}

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
export function SessionCompactDialog({
  open,
  sessionId,
  compress,
  onClose,
}: {
  open: boolean;
  sessionId: string;
  compress: (sessionId: string) => Promise<CompressSessionResult>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "working" | "done" | "error">("idle");
  const [result, setResult] = useState<CompressSessionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Guards against a resolve landing after a newer run or after close/reopen.
  const requestSeq = useRef(0);

  // Reset to the confirmation each time the dialog (re)opens so a prior run's
  // result or error never leaks into a fresh session's confirmation.
  useEffect(() => {
    if (open) {
      requestSeq.current++;
      setPhase("idle");
      setResult(null);
      setErrorMessage(null);
    }
  }, [open]);

  function runCompaction() {
    const seq = ++requestSeq.current;
    setPhase("working");
    setErrorMessage(null);
    compress(sessionId).then(
      (next) => {
        if (seq !== requestSeq.current) return;
        setResult(next);
        setPhase("done");
      },
      (err) => {
        if (seq !== requestSeq.current) return;
        setErrorMessage(
          isSessionBusyError(err)
            ? "June is running right now. Wait for the current turn to finish, then compact context."
            : "Couldn't compact context. Please try again.",
        );
        setPhase("error");
      },
    );
  }

  const working = phase === "working";

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!working) onClose();
      }}
      title="Compact context"
      leading={<IconConcise size={16} aria-hidden />}
      width={440}
      disableBackdropClose={working}
      footer={
        phase === "done" ? (
          <button type="button" className="primary-action" onClick={onClose}>
            Done
          </button>
        ) : phase === "error" ? (
          <>
            <button type="button" className="primary-action" onClick={onClose}>
              Close
            </button>
            <button type="button" className="primary-action primary-solid" onClick={runCompaction}>
              Try again
            </button>
          </>
        ) : (
          <>
            <button type="button" className="primary-action" onClick={onClose} disabled={working}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={runCompaction}
              disabled={working}
            >
              {working ? "Compacting…" : "Compact context"}
            </button>
          </>
        )
      }
    >
      <div className="agent-compact-body">
        {phase === "done" ? (
          <CompactSuccess result={result} />
        ) : phase === "error" ? (
          <InlineNotice
            className="agent-compact-error"
            tone="destructive"
            role="alert"
            body={errorMessage ?? "Couldn't compact context. Please try again."}
          />
        ) : (
          <>
            <p className="agent-compact-explainer">
              This summarizes older context so the agent can continue with a smaller working memory.
            </p>
            <p className="agent-compact-caveat">
              Older messages may be summarized. The agent keeps a reference summary rather than the
              full earlier transcript.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Success body for {@link SessionCompactDialog}: a confirmation line, plus the
 * before/after token reading ONLY when the result reported both (never a
 * guessed or partial figure). */
function CompactSuccess({ result }: { result: CompressSessionResult | null }) {
  const before = result?.beforeTokens;
  const after = result?.afterTokens;
  const hasSavings = before !== undefined && after !== undefined;
  const saved = hasSavings ? Math.max(0, before - after) : undefined;

  return (
    <div className="agent-compact-success" role="status">
      <p className="agent-compact-success-line">
        <IconCheckCircle2 size={15} aria-hidden />
        Context compacted
      </p>
      {hasSavings ? (
        <p className="agent-compact-savings">
          {before.toLocaleString()} to {after.toLocaleString()} tokens
          {saved !== undefined && saved > 0 ? ` (${saved.toLocaleString()} saved)` : ""}
        </p>
      ) : (
        <p className="agent-compact-savings" data-unavailable="true">
          The agent now continues with a smaller working memory.
        </p>
      )}
    </div>
  );
}

// The shared .error-banner tint, with actions: dismiss always, and "Try again"
// when the failure is connection-shaped and reconnecting can actually fix it.
function AgentErrorBanner({
  message,
  onDismiss,
  onReportBug,
  onRetry,
  reportBugSubmitting = false,
}: {
  message: string;
  onDismiss: () => void;
  onReportBug?: () => void;
  onRetry?: () => void;
  reportBugSubmitting?: boolean;
}) {
  return (
    <div className="error-banner agent-error-banner" role="alert">
      <p>{message}</p>
      <div className="agent-error-banner-actions">
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        {onReportBug ? (
          <button type="button" onClick={onReportBug} disabled={reportBugSubmitting}>
            {reportBugSubmitting ? "Sending" : "Send bug report"}
          </button>
        ) : null}
        <button type="button" aria-label="Dismiss" onClick={onDismiss}>
          <IconCrossMedium size={14} />
        </button>
      </div>
    </div>
  );
}

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
function CreditsNoticePart({
  onTopUp,
  topUpLabel = "Upgrade",
  tier,
}: {
  onTopUp?: () => void;
  topUpLabel?: string;
  tier?: FundingTier;
}) {
  return (
    <InlineNotice
      className="agent-credits-notice"
      tone="destructive"
      role="alert"
      icon={tier ? <TierMiniCard tier={tier} /> : <IconExclamationTriangle size={14} aria-hidden />}
      body="June stopped because your balance ran out."
      actions={
        onTopUp ? (
          <button type="button" className="btn btn-secondary" onClick={onTopUp}>
            {topUpLabel}
          </button>
        ) : undefined
      }
    />
  );
}

function UpstreamProviderFailureNoticePart({
  attempted = false,
  disabled = false,
  onRetry,
}: {
  attempted?: boolean;
  disabled?: boolean;
  onRetry?: () => void;
}) {
  return (
    <InlineNotice
      className="agent-upstream-provider-notice"
      tone="warning"
      role="alert"
      icon={<IconExclamationTriangle size={14} aria-hidden />}
      body={UPSTREAM_PROVIDER_FAILURE_NOTICE_BODY}
      actions={
        onRetry ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={attempted || disabled}
            onClick={onRetry}
          >
            Try again
          </button>
        ) : undefined
      }
    />
  );
}

// A turn that died because the request outgrew the model's context (or the
// agent request-size limit) folds into this card instead of a raw "Cannot
// compress further." error with only Copy/Branch (JUN-169). On a single
// oversized turn there is nothing to compress, so the honest recovery is to
// shrink the input or start fresh, not to retry as-is. No wired action yet —
// the guidance points at the composer / branch controls already on the turn.
function ContextOverflowNoticePart() {
  return (
    <InlineNotice
      className="agent-context-overflow-notice"
      tone="warning"
      role="alert"
      icon={<IconExclamationTriangle size={14} aria-hidden />}
      body="This message is too large for the model's context. Try attaching a smaller file, splitting it into parts, or starting a new session."
    />
  );
}

/** A "Steering" system item (feature 06): the instruction the user redirected
 * June toward mid-run, recorded quietly in the transcript so the conversation
 * shows what changed course. Mirrors {@link ContextCompactionPart}'s quiet,
 * timestamped system-row styling. */
function SteeringPart({ part }: { part: Extract<AgentChatPart, { type: "steering" }> }) {
  return (
    <div className="agent-steering-item">
      <span className="agent-steering-icon" aria-hidden>
        <IconArrowCornerDownRight size={14} />
      </span>
      <span className="agent-steering-label">Steering</span>
      <span className="agent-steering-text">{part.text}</span>
    </div>
  );
}

// The `/image` result, inline in the assistant turn. Running -> generation state;
// complete -> the image (click to enlarge in the file viewer) with a download
// action; error -> the failure message. The bytes ride in `part.dataUrl` for an
// instant thumbnail; open/download key off the imported workspace path.
/* The June Agents mark sampled onto the generating dot lattice, one character
 * per 6px cell: "." = outside the glyph, digits 1-9 = the fraction of the
 * cell the glyph covers. Derived from src/assets/june-agents-mark.svg by
 * rasterizing with a slight blur (4px at 10px cells) and averaging per-cell
 * alpha - the blur spreads each edge across two cells, so dots taper in size
 * and tone toward the boundary and the glyph keeps its soft rounded edges
 * instead of a hard binary cutout. */
const GENERATED_MEDIA_MARK_CELLS = [
  "..................157775",
  "..................179997",
  "..................289997",
  "..................389997",
  ".....1122222222223798875",
  "....15777777777788973211",
  "....1799999999999983....",
  "....2899999999999982....",
  "....3899999999999971....",
  "11237988777777777751....",
  "5788973222222222211.....",
  "799983..................",
  "799982.............11211",
  "799971............157775",
  "577751............179997",
  "11211.............289997",
  "..................389997",
  ".....1122222222223798875",
  "....15777777777788973211",
  "....1799999999999983....",
  "....2899999999999982....",
  "....3899999999999971....",
  "11237988777777777751....",
  "5788973222222222211.....",
  "799983..................",
  "799982..................",
  "799971..................",
  "577751..................",
];

/* One shared parameter set so the two wave kinds stay in the same physical
 * register: a wavefront is a gaussian band that brightens dots and pushes
 * them away from its source; dots ease back as the band moves on. */
const GENERATED_MEDIA_FIELD = {
  pitch: 6,
  dotRadius: 1,
  markDotRadius: 1.25,
  markGlowGain: 1.2,
  maxAlpha: 0.85,
  /* The ambient sheen: a plane wavefront crossing left to right, both ends
   * fully off-canvas so the loop reset is invisible, then a rest beat. The
   * band leans at the shared shimmer utility's 20deg so the canvas sweep and
   * the label shimmer read as one system. */
  sweepCycleMs: 3600,
  sweepTravelMs: 2400,
  sweepSigma: 34,
  sweepPush: 2.2,
  sweepAngleDeg: 20,
  /* Pointer ripples: a radial wavefront expanding from the tap point. The
   * band also paints the dots it crosses with the theme accent. */
  ripplePxPerMs: 0.24,
  rippleSigma: 24,
  rippleTauMs: 950,
  ripplePush: 5,
  rippleGlow: 0.4,
  ripplePaintMix: 0.95,
  /* Mark sparkle: each logo dot glints on its own deterministic cadence - a
   * brief flash of clay brightness, never size. The glint is clay-tinted
   * (sparkMix) rather than gray so the mark reads as warm, but the tint only
   * lands clean because --brand-bright is a *luminous* clay (fixed high
   * lightness + healthy chroma); a duller white-mixed clay turns to mud over
   * the light dot field. The pulse uses a near-instant attack and a longer
   * release, matching the clean snap of a light catching an edge instead of a
   * soft sine-wave throb. The staggered cadence keeps the mark alive without
   * making every dot pulse at once; the press ripple keeps the fuller accent
   * burst (ripplePaintMix) for a deliberate tap. */
  sparkMinRadPerSec: 1.6,
  sparkSpanRadPerSec: 1.2,
  sparkAttackRatio: 0.025,
  sparkDecayRatio: 0.1,
  sparkMix: 0.72,
  sparkAlphaBoost: 0.52,
  /* The dot field thins out over this many px at the canvas bottom, into the
   * card-surface gradient the CSS background lands on. */
  bottomFadePx: 56,
};

type GeneratedMediaRipple = { x: number; y: number; startedAt: number };

/** The particle dot field behind a generating image/video: a fine stationary
 * lattice carrying the June Agents mark as brighter dots, with a soft sheen
 * wavefront sweeping across on a fixed cadence. Pointer taps drop radial
 * ripples that push dots outward and let them settle back. Dot positions are
 * a pure function of time (no per-dot state), so dropped frames never desync
 * the motion; reduced motion renders a single static frame. */
function GeneratedMediaDotField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ripplesRef = useRef<GeneratedMediaRipple[]>([]);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    const F = GENERATED_MEDIA_FIELD;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return; // test env has no 2d context

    let width = 0;
    let height = 0;
    // `mark` is the glyph-coverage weight of this lattice cell, 0..1; the
    // spark fields give each logo dot its own deterministic glint cadence.
    let dots: Array<{
      x: number;
      y: number;
      mark: number;
      sparkOmega: number;
      sparkPhase: number;
    }> = [];
    let raf = 0;

    /* The ink colors and per-theme alphas live in CSS so the field follows
     * the design tokens; the canvas reads their computed values. The theme
     * accent rides in through `accent-color`, which computes to a concrete
     * color without painting anything on a canvas element. */
    const readInk = () => {
      const style = getComputedStyle(canvas);
      const accent = style.accentColor;
      return {
        color: style.color,
        spark: accent && accent !== "auto" ? accent : style.color,
        dotAlpha: Number.parseFloat(style.getPropertyValue("--agent-generated-dot-alpha")) || 0.08,
        sheenGlow:
          Number.parseFloat(style.getPropertyValue("--agent-generated-sheen-glow")) || 0.24,
        markAlpha:
          Number.parseFloat(style.getPropertyValue("--agent-generated-mark-alpha")) || 0.32,
      };
    };
    let ink = readInk();

    const rebuild = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.round(rect.width);
      height = Math.round(rect.height);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cols = Math.ceil(width / F.pitch);
      const rows = Math.ceil(height / F.pitch);
      const markCols = GENERATED_MEDIA_MARK_CELLS[0].length;
      const markRows = GENERATED_MEDIA_MARK_CELLS.length;
      // Centered on the lattice, lifted one row to balance the footer bar.
      const markCol = Math.round((cols - markCols) / 2);
      const markRow = Math.round((rows - markRows) / 2) - 1;
      dots = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const inMark =
            row >= markRow &&
            row < markRow + markRows &&
            col >= markCol &&
            col < markCol + markCols;
          const cell = inMark ? GENERATED_MEDIA_MARK_CELLS[row - markRow][col - markCol] : ".";
          const mark = cell === "." ? 0 : Number.parseInt(cell, 10) / 9;
          // Two lattice-position hashes decorrelate each dot's glint cycle.
          const noise = Math.sin((row * 131 + col) * 12.9898) * 43758.5453;
          const seed = noise - Math.floor(noise);
          const noise2 = Math.sin((row * 131 + col) * 78.233) * 12543.8567;
          const seed2 = noise2 - Math.floor(noise2);
          dots.push({
            x: col * F.pitch + F.pitch / 2,
            y: row * F.pitch + F.pitch / 2,
            mark,
            sparkOmega: F.sparkMinRadPerSec + seed * F.sparkSpanRadPerSec,
            sparkPhase: seed2 * Math.PI * 2,
          });
        }
      }
    };

    const epoch = performance.now();
    // The sweep axis: dots are banded by their projection onto this direction.
    const sweepCos = Math.cos((F.sweepAngleDeg * Math.PI) / 180);
    const sweepSin = Math.sin((F.sweepAngleDeg * Math.PI) / 180);

    const draw = (t: number, animated: boolean) => {
      const ripples = ripplesRef.current;
      for (let i = ripples.length - 1; i >= 0; i--) {
        if (t - ripples[i].startedAt > 6 * F.rippleTauMs) ripples.splice(i, 1);
      }
      let front: number | null = null;
      if (animated) {
        const phase = ((t - epoch) % F.sweepCycleMs) / F.sweepTravelMs;
        const span = width * sweepCos + height * sweepSin;
        if (phase <= 1) front = -3 * F.sweepSigma + phase * (span + 6 * F.sweepSigma);
      }
      context.clearRect(0, 0, width, height);
      let fill = ink.color;
      context.fillStyle = fill;
      const setFill = (color: string) => {
        if (color !== fill) {
          fill = color;
          context.fillStyle = color;
        }
      };
      const seconds = t / 1000;
      for (const dot of dots) {
        let glow = 0;
        let paint = 0;
        let dx = 0;
        let dy = 0;
        if (front !== null) {
          const along = dot.x * sweepCos + dot.y * sweepSin;
          const band = Math.exp(-((along - front) ** 2) / (2 * F.sweepSigma ** 2));
          glow += ink.sheenGlow * band;
          dx += F.sweepPush * band * sweepCos;
          dy += F.sweepPush * band * sweepSin;
        }
        for (const ripple of ripples) {
          const age = t - ripple.startedAt;
          if (age < 0) continue;
          const rx = dot.x - ripple.x;
          const ry = dot.y - ripple.y;
          const dist = Math.hypot(rx, ry) || 1;
          const band =
            Math.exp(-((dist - F.ripplePxPerMs * age) ** 2) / (2 * F.rippleSigma ** 2)) *
            Math.exp(-age / F.rippleTauMs);
          glow += F.rippleGlow * band;
          paint += band;
          dx += (rx / dist) * F.ripplePush * band;
          dy += (ry / dist) * F.ripplePush * band;
        }
        // The glint: a quick accent strike with a slightly longer fade, out of
        // each logo dot's staggered cycle.
        let spark = 0;
        if (animated && dot.mark > 0) {
          const cycle =
            ((seconds * dot.sparkOmega + dot.sparkPhase) % (Math.PI * 2)) / (Math.PI * 2);
          if (cycle < F.sparkAttackRatio) {
            const progress = cycle / F.sparkAttackRatio;
            spark = progress * progress * (3 - 2 * progress);
          } else if (cycle < F.sparkAttackRatio + F.sparkDecayRatio) {
            const progress = (cycle - F.sparkAttackRatio) / F.sparkDecayRatio;
            spark = 1 - progress * progress * (3 - 2 * progress);
          }
          spark *= dot.mark;
        }
        // Partial glyph coverage blends the dot between field and mark, so
        // the mark's rounded corners and bevels stay soft on the lattice.
        const base = ink.dotAlpha + (ink.markAlpha - ink.dotAlpha) * dot.mark;
        const gain = 1 + (F.markGlowGain - 1) * dot.mark;
        // Thin the field out where the canvas background gradates into the
        // card surface, so the grid gives way instead of hitting an edge.
        const edge = Math.min(1, (height - dot.y) / F.bottomFadePx);
        const bottomFade = edge * edge * (3 - 2 * edge);
        const alpha =
          Math.min(F.maxAlpha, base + glow * gain + spark * F.sparkAlphaBoost) * bottomFade;
        const radius = F.dotRadius + (F.markDotRadius - F.dotRadius) * dot.mark;
        // How much of the dot's paint comes from the theme accent: the glint
        // plus the ripple's burst of color from a press.
        const mix = Math.min(0.95, spark * F.sparkMix + paint * F.ripplePaintMix);
        const x = dot.x + dx;
        const y = dot.y + dy;
        if (mix > 0.02) {
          setFill(ink.spark);
          context.globalAlpha = alpha * mix;
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.fill();
        }
        setFill(ink.color);
        context.globalAlpha = alpha * (1 - mix);
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      draw(performance.now(), true);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const applyMotionPreference = () => {
      reducedMotionRef.current = reducedMotion.matches;
      stop();
      if (reducedMotion.matches) {
        ripplesRef.current = [];
        draw(performance.now(), false);
      } else {
        raf = requestAnimationFrame(frame);
      }
    };

    rebuild();
    // The generation "lands" with one ripple from the center of the canvas.
    ripplesRef.current = [{ x: width / 2, y: height / 2, startedAt: epoch + 50 }];
    applyMotionPreference();
    reducedMotion.addEventListener("change", applyMotionPreference);

    const resizeObserver = new ResizeObserver(() => {
      rebuild();
      if (reducedMotionRef.current) draw(performance.now(), false);
    });
    resizeObserver.observe(canvas);

    // Theme flips swap the computed ink; repaint with the new values.
    const themeObserver = new MutationObserver(() => {
      ink = readInk();
      if (reducedMotionRef.current) draw(performance.now(), false);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      stop();
      reducedMotion.removeEventListener("change", applyMotionPreference);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (reducedMotionRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    ripplesRef.current.push({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      startedAt: performance.now(),
    });
  };

  return (
    <canvas
      ref={canvasRef}
      className="agent-generated-media-field"
      onPointerDown={handlePointerDown}
    />
  );
}

/** A quiet particle dot-field canvas — carrying the June Agents mark — with
 * its working label in a separate footer. */
function AgentGeneratedMediaPlaceholder({ kind }: { kind: "image" | "video" }) {
  const label = kind === "image" ? "Generating image…" : "Generating video…";
  return (
    <div className="agent-generated-media-placeholder-card">
      <div className={`agent-generated-${kind}-placeholder`} aria-hidden>
        <GeneratedMediaDotField />
      </div>
      <div className="agent-generated-media-status-bar">
        <span className="agent-generated-media-label text-shimmer shimmer">{label}</span>
      </div>
    </div>
  );
}

/** Completion reveal for generated media: when a watched running turn
 * completes and its bytes are ready, the media develops out of the generating
 * field - the dot-field surface mounts over it (its entrance ripple doubling
 * as the completion burst) and dissolves. Arming on the running -> complete
 * flip keeps history loads and reduced motion on the instant swap. */
function useGeneratedMediaReveal(status: "running" | "complete" | "error", ready: boolean) {
  const [revealing, setRevealing] = useState(false);
  const armedRef = useRef(false);
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current === "running" && status === "complete") {
      armedRef.current = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    prevStatusRef.current = status;
  }, [status]);
  useEffect(() => {
    if (!armedRef.current || status !== "complete" || !ready) return;
    armedRef.current = false;
    setRevealing(true);
    const timer = setTimeout(() => setRevealing(false), 900);
    return () => clearTimeout(timer);
  }, [status, ready]);
  return revealing;
}

function AgentGeneratedImage({
  part,
  onOpen,
  onDownload,
  onRetry,
}: {
  part: Extract<AgentChatPart, { type: "image" }>;
  onOpen?: (part: Extract<AgentChatPart, { type: "image" }>) => void;
  onDownload?: (part: Extract<AgentChatPart, { type: "image" }>) => void;
  onRetry?: () => void;
}) {
  const [pathPreviewDataUrl, setPathPreviewDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (part.status !== "complete" || part.dataUrl || !part.path) {
      setPathPreviewDataUrl(null);
      return;
    }
    let cancelled = false;
    setPathPreviewDataUrl(null);
    hermesBridgeFilePreview(part.path)
      .then((dataUrl) => {
        if (!cancelled) setPathPreviewDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setPathPreviewDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [part.status, part.dataUrl, part.path]);

  const imageSrc = part.dataUrl ?? pathPreviewDataUrl;
  const revealing = useGeneratedMediaReveal(part.status, Boolean(imageSrc));

  if (part.status === "running") {
    return (
      <div
        className="agent-generated-image"
        data-status="running"
        role="status"
        aria-label="Generating image"
        aria-live="polite"
      >
        <AgentGeneratedMediaPlaceholder kind="image" />
      </div>
    );
  }
  if (part.status === "error") {
    return (
      <div className="agent-generated-image" data-status="error">
        <p className="agent-generated-image-error">
          {part.error?.trim() || "Could not generate the image."}
        </p>
        {onRetry && part.requestId ? (
          <button type="button" className="agent-generated-image-retry" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    );
  }
  const label = part.name?.trim() || "Generated image";
  // "Open" enlarges filesystem-backed images in the artifact viewer. MCP image
  // blocks have only inline bytes, so they render as a plain frame; Hermes
  // MEDIA references have a path and lazily fetch their preview data url above.
  const image = imageSrc ? (
    <img src={imageSrc} alt={part.prompt} draggable={false} />
  ) : part.path ? (
    <span className="agent-generated-image-loading text-shimmer shimmer">Loading image...</span>
  ) : null;
  const reveal = revealing ? (
    <span className="agent-generated-media-reveal" aria-hidden>
      <GeneratedMediaDotField />
    </span>
  ) : null;
  return (
    <figure
      className="agent-generated-image"
      data-status="complete"
      data-revealing={revealing ? "true" : undefined}
    >
      {part.path ? (
        <button
          type="button"
          className="agent-generated-image-frame"
          onClick={() => onOpen?.(part)}
          aria-label={`Open ${label}`}
          title="Open image"
        >
          {image}
          {reveal}
        </button>
      ) : (
        <div className="agent-generated-image-frame">
          {image}
          {reveal}
        </div>
      )}
      <figcaption className="agent-generated-image-bar">
        <span className="agent-generated-image-name" title={label}>
          {label}
        </span>
        {onDownload ? (
          <button
            type="button"
            className="agent-generated-image-download"
            onClick={() => onDownload(part)}
            aria-label="Download image"
            title="Download image"
          >
            <IconArrowInbox size={15} aria-hidden />
            <span>Download</span>
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

function AgentGeneratedVideo({
  part,
  onDownload,
  onRetry,
  retryDisabledReason,
}: {
  part: Extract<AgentChatPart, { type: "video" }>;
  onDownload?: (part: Extract<AgentChatPart, { type: "video" }>) => void;
  onRetry?: () => void;
  retryDisabledReason?: string;
}) {
  const src = part.status === "complete" && part.path ? localVideoFileSrc(part.path) : undefined;
  const [capturedPoster, setCapturedPoster] = useState<{ src: string; dataUrl: string }>();
  const poster =
    part.posterDataUrl ??
    (capturedPoster && capturedPoster.src === src ? capturedPoster.dataUrl : undefined);
  const revealing = useGeneratedMediaReveal(part.status, Boolean(src));

  useEffect(() => {
    // Capture the poster off an offscreen element so the visible player can stay
    // in no-CORS mode: the asset protocol omits `Access-Control-Allow-Origin` on
    // 416 range responses, and only the canvas capture needs CORS.
    if (!src || part.posterDataUrl || poster) return;
    let mounted = true;
    void capturedGeneratedVideoPoster(src).then((dataUrl) => {
      if (mounted && dataUrl) setCapturedPoster({ src, dataUrl });
    });
    return () => {
      mounted = false;
    };
  }, [src, part.posterDataUrl, poster]);

  if (part.status === "running") {
    return (
      <div
        className="agent-generated-video"
        data-status="running"
        role="status"
        aria-label="Generating video"
        aria-live="polite"
      >
        <AgentGeneratedMediaPlaceholder kind="video" />
      </div>
    );
  }
  if (part.status === "error") {
    return (
      <div className="agent-generated-video" data-status="error">
        <p className="agent-generated-image-error">
          {part.error?.trim() || "Could not generate the video."}
        </p>
        {onRetry && part.requestId ? (
          retryDisabledReason ? (
            <HoverTip tip={retryDisabledReason} tabIndex={0}>
              <button type="button" className="agent-generated-image-retry" disabled>
                Try again
              </button>
            </HoverTip>
          ) : (
            <button type="button" className="agent-generated-image-retry" onClick={onRetry}>
              Try again
            </button>
          )
        ) : null}
      </div>
    );
  }
  const label = part.name?.trim() || "Generated video";
  return (
    <figure
      className="agent-generated-video"
      data-status="complete"
      data-revealing={revealing ? "true" : undefined}
    >
      <div className="agent-generated-video-frame">
        {src ? (
          <video controls src={firstFrameVideoSource(src)} poster={poster} preload="metadata" />
        ) : (
          <span className="agent-generated-image-loading text-shimmer shimmer">
            Loading video...
          </span>
        )}
        {revealing ? (
          <span className="agent-generated-media-reveal" aria-hidden>
            <GeneratedMediaDotField />
          </span>
        ) : null}
      </div>
      <figcaption className="agent-generated-image-bar">
        <span className="agent-generated-image-name" title={label}>
          {label}
        </span>
        {onDownload && part.path ? (
          <button
            type="button"
            className="agent-generated-image-download"
            onClick={() => onDownload(part)}
            aria-label="Download video"
            title="Download video"
          >
            <IconArrowInbox size={15} aria-hidden />
            <span>Download</span>
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

function firstFrameVideoSource(src: string) {
  return src.includes("#") ? src : `${src}#t=0.001`;
}

// Poster capture is CORS-mode work (canvas.toDataURL taints without it), so it
// runs on a throwaway offscreen element rather than the visible player. Cache
// the in-flight promise per src so the capture runs at most once per app run,
// even across remounts.
const generatedVideoPosterCache = new Map<string, Promise<string | undefined>>();

export function resetGeneratedVideoPosterCacheForTest() {
  generatedVideoPosterCache.clear();
}

function capturedGeneratedVideoPoster(src: string): Promise<string | undefined> {
  const cached = generatedVideoPosterCache.get(src);
  if (cached) return cached;
  const capture = new Promise<string | undefined>((resolve) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    const finish = (dataUrl?: string) => {
      video.removeAttribute("src");
      video.load();
      resolve(dataUrl);
    };
    video.addEventListener("loadeddata", () => finish(firstFramePosterDataUrl(video)), {
      once: true,
    });
    video.addEventListener("error", () => finish(), { once: true });
    video.src = firstFrameVideoSource(src);
  });
  generatedVideoPosterCache.set(src, capture);
  return capture;
}

function firstFramePosterDataUrl(video: HTMLVideoElement): string | undefined {
  if (!video.videoWidth || !video.videoHeight) return undefined;
  const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    // Asset-protocol or codec restrictions should never block video playback.
    return undefined;
  }
}

/** A resolved action card renders as a quiet, expandable one-line row instead
 * of a full card — a receipt in the transcript rather than a prompt. The row
 * mirrors {@link ContextCompactionPart}: an outcome glyph (checkmark / cross /
 * warning)
 * that cross-fades to a plain-text "+"/"−" on hover (pure opacity — no layout
 * shift, a WKWebView compositing constraint), a short outcome label, and a
 * truncated one-line detail. Expanding reveals the full detail body (the
 * `children`) minus the action buttons. */
function ResolvedActionRow({
  denied = false,
  unknown = false,
  label,
  detail,
  children,
}: {
  /** Renders the cross glyph and destructive tint instead of the checkmark. */
  denied?: boolean;
  /** Renders a neutral warning glyph when the transport lost the outcome. */
  unknown?: boolean;
  /** Short outcome word(s), e.g. "Approved once" / "Answered" / "Denied". */
  label: string;
  /** One-line truncated detail shown inline on the collapsed row. */
  detail?: ReactNode;
  /** The full detail body revealed on expand. */
  children?: ReactNode;
}) {
  return (
    <details
      className="agent-tool-disclosure agent-resolved-row"
      data-choice={unknown ? "unknown" : denied ? "deny" : "done"}
    >
      <summary>
        <span className="agent-tool-icon">
          {unknown ? (
            <IconExclamationTriangle
              size={15}
              className="agent-tool-icon-glyph agent-resolved-icon-glyph"
            />
          ) : denied ? (
            <IconCrossSmall size={15} className="agent-tool-icon-glyph agent-resolved-icon-glyph" />
          ) : (
            <IconCheckmark2Small
              size={15}
              className="agent-tool-icon-glyph agent-resolved-icon-glyph"
            />
          )}
          <span className="agent-tool-icon-expand">+</span>
          <span className="agent-tool-icon-minimize">−</span>
        </span>
        <span className="agent-tool-name agent-resolved-label">{label}</span>
        {detail !== undefined ? <span className="agent-resolved-detail">{detail}</span> : null}
      </summary>
      {children !== undefined ? <div className="agent-resolved-body">{children}</div> : null}
    </details>
  );
}

/** The condensed chrome shared by the pending approval and sudo cards. The
 * header is a plain row (title + optional inline mode tag + waiting status) —
 * not a toggle. Below it the prose `description` reads at all times, clamped to
 * two lines while collapsed. When there is more to show (`hasDetails` — a
 * command, or the sudo mode notice) a quiet "Details" disclosure sits under the
 * description and reveals the full body (`children`: the full command `pre` and
 * any extra detail). The actions row (`footer`) is always visible. Collapsed by
 * default so a long command never dominates the card before a decision. */
function CollapsibleActionCard({
  title,
  description,
  headerMeta,
  command,
  hasDetails,
  expanded,
  onToggleExpanded,
  footer,
  children,
}: {
  title: string;
  /** The prose description (part.description / sudo reason), always visible. */
  description: ReactNode;
  /** A short signal pinned to the header row that must stay visible while
   * collapsed (e.g. the sudo blast-radius mode tag). */
  headerMeta?: ReactNode;
  /** SECURITY: the concrete command being authorized. Rendered ALWAYS (never
   * behind the disclosure) so the exact command is visible at the decision
   * point — the Approve button is live while the card is collapsed, so a user
   * must be able to see what they are approving without expanding anything. */
  command?: ReactNode;
  /** Whether there is supplementary body content worth a "Details" disclosure
   * (e.g. the sudo mode notice). The command is NOT gated on this. */
  hasDetails: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** The actions row (or the in-flight result line), always visible. */
  footer: ReactNode;
  /** Supplementary body revealed on expand (never the command). */
  children: ReactNode;
}) {
  return (
    <article
      className="agent-approval-card agent-action-card"
      data-status="pending"
      data-expanded={expanded || undefined}
    >
      <div className="agent-action-card-header">
        <span className="agent-action-card-title">{title}</span>
        {headerMeta}
      </div>
      {/* Only clamp when a Details expander exists to reveal the rest; otherwise
       * a long description-only request would be truncated with no way to read
       * it before choosing. */}
      <p
        className="agent-action-card-description"
        data-clamped={(hasDetails && !expanded) || undefined}
      >
        {description}
      </p>
      {command}
      {hasDetails ? (
        <button
          type="button"
          className="agent-action-card-details"
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          Details
          <IconChevronDownSmall size={14} className="agent-disclosure-chevron" aria-hidden />
        </button>
      ) : null}
      {expanded ? <div className="agent-action-card-body">{children}</div> : null}
      {footer}
    </article>
  );
}

/** The approval footer's primary control: a split button. "Approve" approves
 * "once"; the attached caret opens a small scope menu ("Approve once" /
 * "Approve for this session" / "Always approve", the last hidden when
 * `allowPermanent` is false). Dismisses on outside click or Escape and supports
 * arrow-key navigation, mirroring the repo's other hand-rolled menus. */
function ApproveSplitButton({
  disabled,
  allowPermanent,
  onChoice,
}: {
  disabled: boolean;
  allowPermanent?: boolean;
  onChoice: (choice: AgentApprovalChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const scopeRef = useRef<HTMLButtonElement | null>(null);

  // Close on a click outside the split wrapper or on Escape.
  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        // Escape is a keyboard dismissal — return focus to the caret trigger so
        // it doesn't drop to <body> when the focused menu item unmounts.
        scopeRef.current?.focus();
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Move focus into the menu when it opens so arrow keys land immediately.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const items: { choice: AgentApprovalChoice; label: string }[] = [
    { choice: "once", label: "Approve once" },
    { choice: "session", label: "Approve for this session" },
    ...(allowPermanent
      ? [{ choice: "always" as AgentApprovalChoice, label: "Always approve" }]
      : []),
  ];

  function choose(choice: AgentApprovalChoice) {
    setOpen(false);
    onChoice(choice);
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[(current + 1 + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(current - 1 + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    }
  }

  return (
    <div className="agent-approval-split" ref={wrapRef}>
      <button
        type="button"
        className="agent-approval-approve"
        disabled={disabled}
        onClick={() => onChoice("once")}
      >
        Approve
      </button>
      <button
        ref={scopeRef}
        type="button"
        className="agent-approval-scope"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Approve options"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <IconChevronDownSmall size={14} aria-hidden />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="agent-approval-scope-menu"
          role="menu"
          aria-label="Approve scope"
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.choice}
              type="button"
              role="menuitem"
              className="agent-approval-scope-item"
              disabled={disabled}
              onClick={() => choose(item.choice)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ClarifyPart({
  onClarify,
  part,
  submitting,
}: {
  onClarify: (part: Extract<AgentChatPart, { type: "clarify" }>, answer: string) => void;
  part: Extract<AgentChatPart, { type: "clarify" }>;
  submitting?: string;
}) {
  const [typing, setTyping] = useState(part.choices.length === 0);
  const [draft, setDraft] = useState("");
  const disabled = part.status !== "pending" || submitting !== undefined;

  // Resolved clarify collapses to a quiet receipt row: "Answered" (or "Skipped")
  // plus the question, expandable to the full question and answer.
  if (part.status !== "pending") {
    const answered = Boolean(part.answer?.trim());
    return (
      <ResolvedActionRow label={answered ? "Answered" : "Skipped"} detail={part.question}>
        <p>{part.question}</p>
        {answered ? <p className="agent-clarify-answer">{part.answer}</p> : null}
      </ResolvedActionRow>
    );
  }

  return (
    <article className="agent-clarify-card" data-status={part.status}>
      <div>
        <div className="agent-tool-title">
          <span>Clarify</span>
        </div>
        <p className="agent-clarify-question">{part.question}</p>
        {part.status === "pending" ? (
          <>
            {!typing && part.choices.length ? (
              <div className="agent-clarify-choices">
                {part.choices.map((choice, index) => (
                  <button
                    type="button"
                    key={`${index}:${choice}`}
                    disabled={disabled}
                    onClick={() => onClarify(part, choice)}
                  >
                    <span>{index + 1}</span>
                    {choice}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={submitting !== undefined}
                  onClick={() => setTyping(true)}
                >
                  <span>+</span>
                  Other
                </button>
              </div>
            ) : null}
            {typing || !part.choices.length ? (
              <form
                className="agent-clarify-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const answer = draft.trim();
                  if (answer) onClarify(part, answer);
                }}
              >
                <textarea
                  className="dialog-textarea agent-clarify-textarea"
                  value={draft}
                  disabled={disabled}
                  rows={3}
                  placeholder="Type your answer"
                  onChange={(event) => setDraft(event.currentTarget.value)}
                />
                <div>
                  {part.choices.length ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={submitting !== undefined}
                      onClick={() => {
                        setDraft("");
                        setTyping(false);
                      }}
                    >
                      Back
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={disabled}
                    onClick={() => onClarify(part, "")}
                  >
                    Skip
                  </button>
                  <button
                    type="submit"
                    className="btn btn-secondary"
                    disabled={disabled || !draft.trim()}
                  >
                    {submitting !== undefined ? "Sending" : "Send"}
                  </button>
                </div>
              </form>
            ) : null}
          </>
        ) : null}
      </div>
    </article>
  );
}

type AgentCliAccessCardProps = {
  /** undefined while the stored setting is still loading. */
  enabled?: boolean;
  submitting: boolean;
  onEnable: () => void;
};

/** June asked to enable "Agent CLI access" via the literal token its soul
 * teaches ([REQUEST:AGENT_CLI_ACCESS]). The agent can never flip the setting
 * itself — the flag file sits outside every sandbox write root — so this
 * card is the one-click, user-approved path. Resolution is derived from the
 * live setting rather than stored per message: a revisited transcript shows
 * "Enabled" once the grant is on, and re-offers the choice while it is off.
 * Mirrors the approval card chrome. */
export function AgentCliAccessCard({ cliAccess }: { cliAccess?: AgentCliAccessCardProps }) {
  const [dismissed, setDismissed] = useState(false);
  const enabled = cliAccess?.enabled === true;
  const resolved = enabled || dismissed;
  const busy = Boolean(cliAccess?.submitting);

  const description = (
    <p>
      June wants write access to the state folders of your coding CLIs (Claude Code, Codex, Gemini,
      opencode) so they stay logged in and can save their work in sandboxed sessions. Those folders
      configure software that also runs outside June's sandbox. Enabling turns on "Agent CLI access"
      in Settings and restarts the sandboxed runtime.
    </p>
  );

  // Resolved collapses to a quiet receipt row, expandable to the description.
  if (resolved) {
    return (
      <ResolvedActionRow denied={!enabled} label={enabled ? "Agent CLI access enabled" : "Not now"}>
        {description}
      </ResolvedActionRow>
    );
  }

  return (
    <article className="agent-approval-card" data-status="pending">
      <div>
        <div className="agent-tool-title">
          <span>Agent CLI access requested</span>
        </div>
        {description}
        <div className="agent-approval-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !cliAccess || cliAccess.enabled === undefined}
            onClick={() => cliAccess?.onEnable()}
          >
            {busy ? "Enabling…" : "Enable Agent CLI access"}
          </button>
          <button
            type="button"
            className="btn btn-ghost agent-approval-deny"
            disabled={busy}
            onClick={() => setDismissed(true)}
          >
            Not now
          </button>
        </div>
      </div>
    </article>
  );
}

type AgentBrowserAccessCardProps = {
  /** undefined while the stored grant is still loading. */
  enabled?: boolean;
  submitting: boolean;
  onEnable: () => void;
};

export function BrowserApprovalCard({
  approval,
  submitting,
  onRespond,
}: {
  approval: PendingBrowserApproval;
  submitting: boolean;
  onRespond: (approve: boolean, allowSite: boolean) => void;
}) {
  const action = approval.action.charAt(0).toUpperCase() + approval.action.slice(1);
  return (
    <article className="agent-approval-card" data-status="pending">
      <div className="agent-tool-title">
        <span>Browser approval required</span>
      </div>
      <p>
        Site: {approval.site}
        {"\n"}
        Action: {action}
        {"\n"}
        Element: {approval.elementLabel}
      </p>
      <div className="agent-approval-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={submitting}
          onClick={() => onRespond(true, false)}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={submitting}
          onClick={() => onRespond(true, true)}
        >
          Approve all on this site for this task
        </button>
        <button
          type="button"
          className="btn btn-ghost agent-approval-deny"
          disabled={submitting}
          onClick={() => onRespond(false, false)}
        >
          Decline
        </button>
      </div>
    </article>
  );
}

/** June asked to enable Browser use via the literal token its soul teaches
 * ([REQUEST:BROWSER_ACCESS]). The agent can never flip the setting itself —
 * the Browser access grant is a flag file outside every sandbox write root —
 * so this card is the one-click, user-approved path. Resolution is derived
 * from the live grant rather than stored per message, exactly like the Agent
 * CLI access card above: a revisited transcript shows "Enabled" once the
 * grant is on, and re-offers the choice while it is off. */
export function AgentBrowserAccessCard({
  browserAccess,
}: {
  browserAccess?: AgentBrowserAccessCardProps;
}) {
  const [dismissed, setDismissed] = useState(false);
  const enabled = browserAccess?.enabled === true;
  const resolved = enabled || dismissed;
  const busy = Boolean(browserAccess?.submitting);

  const description = (
    <p>
      June wants to drive your browser to finish this task, in tabs it opens and tabs you explicitly
      share. Page content from those tabs (visible text and screenshots) leaves this device and is
      sent to your configured AI model for inference. Enabling turns on "Browser use" in Settings
      and restarts the agent runtime.
    </p>
  );

  // Resolved collapses to a quiet receipt row, expandable to the description.
  if (resolved) {
    return (
      <ResolvedActionRow denied={!enabled} label={enabled ? "Browser use enabled" : "Not now"}>
        {description}
      </ResolvedActionRow>
    );
  }

  return (
    <article className="agent-approval-card" data-status="pending">
      <div>
        <div className="agent-tool-title">
          <span>Browser use requested</span>
        </div>
        {description}
        <div className="agent-approval-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !browserAccess || browserAccess.enabled === undefined}
            onClick={() => browserAccess?.onEnable()}
          >
            {busy ? "Enabling…" : "Enable Browser use"}
          </button>
          <button
            type="button"
            className="btn btn-ghost agent-approval-deny"
            disabled={busy}
            onClick={() => setDismissed(true)}
          >
            Not now
          </button>
        </div>
      </div>
    </article>
  );
}

export function ApprovalPart({
  onApproval,
  part,
  submitting,
}: {
  onApproval: (
    part: Extract<AgentChatPart, { type: "approval" }>,
    choice: AgentApprovalChoice,
  ) => void;
  part: Extract<AgentChatPart, { type: "approval" }>;
  submitting?: AgentApprovalChoice;
}) {
  const disabled = Boolean(submitting) || part.status !== "pending";
  const activeChoice = part.choice ?? submitting;
  // A card that has actually resolved collapses to a receipt row. A submission
  // still in flight (submitting set, status pending) keeps the card so the
  // in-progress line ("Approving once") stays visible until it resolves.
  const resolved = part.status !== "pending";
  const showResult = resolved || activeChoice !== undefined;
  // The whole card is compact by default; expanding reveals the full body.
  const [expanded, setExpanded] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  // "Explain first" asks the generation model what this specific request
  // would do — the request stays parked, nothing is approved by asking.
  // The answer is cached for the card's lifetime; an error retries on the
  // next open and falls back to static copy meanwhile.
  const [explanation, setExplanation] = useState<string>();
  const [explainState, setExplainState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const explanationId = useId();

  function toggleExplain() {
    const nextOpen = !explainOpen;
    setExplainOpen(nextOpen);
    // Opening the explanation auto-expands the card so the panel has room.
    if (nextOpen) setExpanded(true);
    if (!nextOpen || explainState === "loading" || explainState === "ready") {
      return;
    }
    setExplainState("loading");
    explainAgentApproval({
      description: part.description,
      command: part.command || undefined,
    })
      .then((response) => {
        setExplanation(response.explanation);
        setExplainState("ready");
      })
      .catch(() => {
        setExplainState("error");
      });
  }

  // Resolved collapses to a quiet receipt row: the outcome label plus the
  // command (or description) truncated to one line, expandable to the full
  // description and command — no action buttons.
  if (resolved) {
    if (part.status === "expired") {
      const outcomeUnconfirmed = part.retiredReason === "unconfirmed";
      return (
        <ResolvedActionRow
          denied={!outcomeUnconfirmed}
          unknown={outcomeUnconfirmed}
          label={outcomeUnconfirmed ? "Approval outcome unknown" : "Approval expired"}
          detail={
            part.command ? (
              <span className="agent-resolved-mono">{part.command}</span>
            ) : (
              part.description
            )
          }
        >
          {outcomeUnconfirmed ? (
            <p>
              The connection closed before June could confirm the response. This approval is no
              longer actionable, but it may have already been applied. Check the agent activity
              before retrying.
            </p>
          ) : (
            <p>This approval is no longer pending. June did not approve anything.</p>
          )}
          {part.command ? <pre>{part.command}</pre> : null}
        </ResolvedActionRow>
      );
    }
    return (
      <ResolvedActionRow
        denied={activeChoice === "deny"}
        label={approvalChoiceLabel(activeChoice)}
        detail={
          part.command ? (
            <span className="agent-resolved-mono">{part.command}</span>
          ) : (
            part.description
          )
        }
      >
        <p>{part.description}</p>
        {part.command ? <pre>{part.command}</pre> : null}
      </ResolvedActionRow>
    );
  }

  const footer = showResult ? (
    // Submission in flight (status still pending): the in-progress line stays
    // in the card until the request actually resolves.
    <p className="agent-approval-result" data-choice={activeChoice}>
      {activeChoice === "deny" ? <IconCrossMedium size={14} /> : <IconCheckmark2Small size={14} />}
      {approvalChoiceLabel(activeChoice, submitting !== undefined)}
    </p>
  ) : (
    // Compact footer: a split "Approve" (approves once, caret opens the scope
    // menu) and a quiet "Deny" anchor the row; "Explain first" demotes to a
    // plain text-level button pushed to the right edge.
    <div className="agent-approval-actions">
      <ApproveSplitButton
        disabled={disabled}
        allowPermanent={part.allowPermanent}
        onChoice={(choice) => onApproval(part, choice)}
      />
      <button
        type="button"
        className="btn btn-ghost agent-approval-deny"
        disabled={disabled}
        onClick={() => onApproval(part, "deny")}
      >
        Deny
      </button>
      <button
        type="button"
        className="btn btn-ghost agent-approval-explain"
        aria-expanded={explainOpen}
        // Only advertise the panel while it's actually in the DOM (the body
        // renders only when the card is expanded and the explanation is open).
        aria-controls={explainOpen ? explanationId : undefined}
        disabled={disabled}
        onClick={toggleExplain}
      >
        <IconLightBulbSimple size={14} aria-hidden />
        {explainOpen ? "Hide explanation" : "Explain first"}
      </button>
    </div>
  );

  return (
    <CollapsibleActionCard
      title="Approval required"
      description={part.description}
      command={part.command ? <pre>{part.command}</pre> : null}
      // The command is always shown; the only expandable body is the optional
      // explanation, which its own "Explain first" button toggles.
      hasDetails={false}
      expanded={expanded}
      onToggleExpanded={() => {
        const next = !expanded;
        setExpanded(next);
        if (!next) setExplainOpen(false);
      }}
      footer={footer}
    >
      {explainOpen ? (
        <div className="agent-approval-explanation" id={explanationId}>
          {explainState === "loading" ? (
            <p className="agent-approval-explanation-loading" role="status" aria-live="polite">
              <Spinner aria-hidden />
              <span>Working out what this request does…</span>
            </p>
          ) : explainState === "ready" && explanation ? (
            explanation
              .split(/\n{2,}/)
              .map((paragraph) => paragraph.trim())
              .filter(Boolean)
              .map((paragraph, index) => <p key={index}>{paragraph}</p>)
          ) : (
            // Generation unavailable (offline, signed out): keep the
            // static framing rather than an empty panel.
            <p>
              June is paused because this request needs your explicit permission before it can
              continue.
            </p>
          )}
          <p>
            Approve once allows only this request. This session allows matching requests until the
            session ends.{" "}
            {part.allowPermanent ? "Always allows matching requests in future sessions. " : null}
            Deny blocks the request.
          </p>
        </div>
      ) : null}
    </CollapsibleActionCard>
  );
}

function approvalChoiceLabel(choice?: AgentApprovalChoice, pending = false) {
  if (choice === "once") return pending ? "Approving once" : "Approved once";
  if (choice === "session")
    return pending ? "Approving for this session" : "Approved for this session";
  if (choice === "always") return pending ? "Approving permanently" : "Always approved";
  if (choice === "deny") return pending ? "Denying" : "Denied";
  return "Resolved";
}

export function branchSourceSessionIdForTurn(turn: Pick<AgentChatTurn, "parts">) {
  for (const part of turn.parts) {
    if (!("sessionId" in part)) continue;
    const sessionId = part.sessionId?.trim();
    if (sessionId) return sessionId;
  }
  return undefined;
}

/** Whether a turn is a concrete message — the only kind that carries per-turn
 * affordances (copy / branch / timestamp). A user message always qualifies; an
 * assistant turn qualifies once it has produced a real answer: non-empty text
 * or a finished image. Everything else is process or interaction — thinking in
 * progress, tool calls, approval/clarify/sudo/secret cards, context summaries,
 * in-flight/empty turns — and gets nothing below it. An allowlist (not a
 * per-type blocklist) so new process/card part types stay quiet by default. */
export function turnIsConcreteResponse(turn: Pick<AgentChatTurn, "role" | "parts">) {
  if (turn.role === "user") return true;
  return turn.parts.some(
    (part) =>
      (part.type === "text" && part.text.trim().length > 0) ||
      (part.type === "image" && part.status === "complete"),
  );
}

function previousBranchableMessageIndex(messages: HermesSessionMessage[], beforeIndex: number) {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role !== "tool" && isBranchableMessageId(message.id)) return index;
  }
  return -1;
}

function lastBranchableMessageIndex(messages: HermesSessionMessage[]) {
  return previousBranchableMessageIndex(messages, messages.length);
}

function latestBranchableUserMessageIndex(messages: HermesSessionMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && isBranchableMessageId(message.id)) return index;
  }
  return -1;
}

function liveAssistantBranchPointIndex(
  messages: HermesSessionMessage[],
  pendingMessages: HermesSessionMessage[],
) {
  if (pendingMessages.some((message) => message.role === "user")) {
    return lastBranchableMessageIndex(messages);
  }
  const latestUserIndex = latestBranchableUserMessageIndex(messages);
  if (latestUserIndex >= 0) {
    return previousBranchableMessageIndex(messages, latestUserIndex);
  }
  return lastBranchableMessageIndex(messages);
}

function isLiveAssistantTurnId(id: string) {
  return id.startsWith("assistant:");
}

function canRequestBranchFromTurnId(id: string) {
  return isBranchableMessageId(id) || id.startsWith("pending:user:") || isLiveAssistantTurnId(id);
}

/** The per-message "Branch from here" action (feature 07). Forks the
 * conversation into a NEW session that starts from this message, leaving the
 * source session untouched. Persisted turns branch exactly at their Hermes
 * message id; pending user prompts and live assistant rows are still actionable
 * because the workspace can resolve them to the nearest saved fork point.
 * Other synthetic rows stay clickable but announce why branching is not
 * available yet instead of swallowing the click as a silent no-op (JUN-182).
 * The branch itself flows through the typed `branchSession` method via
 * `onBranch`. */
export function BranchFromHereAction({
  messageId,
  onBranch,
  sessionId,
  submitting,
}: {
  messageId: string;
  onBranch: (messageId: string, sessionId?: string) => void;
  sessionId?: string;
  submitting?: boolean;
}) {
  const branchable = canRequestBranchFromTurnId(messageId);
  const action = (
    <button
      type="button"
      className="agent-turn-action"
      aria-label={submitting ? "Creating branch" : "Branch from here"}
      // Truly inert only while a fork is in flight. A non-branchable turn
      // announces itself disabled but stays clickable, so the click still
      // reaches onBranch and the handler explains why branching isn't
      // available yet instead of failing silently (JUN-182).
      aria-disabled={!branchable || undefined}
      aria-busy={submitting || undefined}
      disabled={submitting}
      onClick={() => onBranch(messageId, sessionId)}
    >
      {submitting ? <DotSpinner /> : <IconBranchSimple size={14} aria-hidden />}
    </button>
  );

  if (submitting) {
    return action;
  }

  const tip = branchable ? "Branch from here" : "Branching is available once the message is saved";
  return (
    <HoverTip
      compact
      width={branchable ? 136 : 216}
      delay={TURN_ACTION_TIP_DELAY_MS}
      // The unavailable reason is honest, not silent: a synthetic/in-flight
      // turn has no persisted id Hermes can fork from yet.
      tip={tip}
      className="agent-turn-action-tip"
    >
      {action}
    </HoverTip>
  );
}

/** A privilege-escalation prompt (`sudo.request`). Approval is EXPLICIT: the
 * card surfaces the command and reason Hermes gave (degrading gracefully when
 * either is absent) and shows the execution mode so the user understands the
 * blast radius before granting. Resolution flows through the typed
 * `respondToSudo` method. Mirrors the approval card chrome. */
export function SudoPart({
  onSudo,
  part,
  submitting,
}: {
  onSudo: (part: Extract<AgentChatPart, { type: "sudo" }>, approved: boolean) => void;
  part: Extract<AgentChatPart, { type: "sudo" }>;
  submitting?: "approve" | "deny";
}) {
  const disabled = Boolean(submitting) || part.status !== "pending";
  // A card that has actually resolved collapses to a receipt row. A submission
  // still in flight (submitting set, status pending) keeps the card.
  const resolved = part.status !== "pending";
  const showResult = resolved || submitting !== undefined;
  // The whole card is compact by default; expanding reveals the full body.
  const [expanded, setExpanded] = useState(false);
  // Absent mode defaults to the safe direction (sandboxed) so the card never
  // implies more access than is being granted.
  const mode: HermesMode = part.mode ?? "sandboxed";
  const unrestricted = mode === "unrestricted";
  const decided = part.approved ?? (submitting ? submitting === "approve" : undefined);

  const modeCopy = unrestricted
    ? "Will run unrestricted (full write access)"
    : "Will run sandboxed (limited write access)";

  // Pending: the blast radius shows as an InlineNotice — warning chrome for
  // unrestricted, neutral for sandboxed.
  const modeNotice = (
    <InlineNotice
      className="agent-sudo-mode-notice"
      tone={unrestricted ? "warning" : "info"}
      icon={
        unrestricted ? (
          <IconShieldCrossed size={14} aria-hidden />
        ) : (
          <IconShieldCheck size={14} aria-hidden />
        )
      }
      body={modeCopy}
    />
  );

  // Receipt: the same mode line, but as quiet plain text — receipts carry no
  // notice chrome.
  const modeReceiptLine = (
    <p className="agent-sudo-mode-receipt" data-mode={mode}>
      {modeCopy}
    </p>
  );

  // Collapsed pending: the full InlineNotice lives behind Details, so the header
  // still has to carry the blast radius at the moment of decision — but only for
  // the unrestricted (elevated) case. A small warning badge pinned in the header
  // row does it. Sandboxed is the safe default and shows no collapsed badge (the
  // full mode line still appears in Details for both).
  const modeBadge = unrestricted ? (
    <span className="agent-sudo-mode-badge">
      <IconExclamationTriangle size={12} aria-hidden />
      Unrestricted
    </span>
  ) : null;

  // Resolved collapses to a quiet receipt row: "Approved"/"Denied" plus the
  // command, expandable to the reason, command, and execution mode.
  if (resolved) {
    return (
      <ResolvedActionRow
        denied={!decided}
        label={decided ? "Approved" : "Denied"}
        detail={
          part.command ? <span className="agent-resolved-mono">{part.command}</span> : undefined
        }
      >
        <p>{part.reason ?? "June needs elevated permissions before it can continue."}</p>
        {part.command ? <pre>{part.command}</pre> : null}
        {modeReceiptLine}
      </ResolvedActionRow>
    );
  }

  const reason = part.reason ?? "June needs elevated permissions before it can continue.";

  const footer = showResult ? (
    <p className="agent-approval-result" data-choice={decided ? "once" : "deny"}>
      {decided ? <IconCheckmark2Small size={14} /> : <IconCrossMedium size={14} />}
      {decided ? (submitting ? "Approving" : "Approved") : submitting ? "Denying" : "Denied"}
    </p>
  ) : (
    // Sudo keeps a simple Approve/Deny pair.
    <div className="agent-approval-actions">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={disabled}
        onClick={() => onSudo(part, true)}
      >
        Approve
      </button>
      <button
        type="button"
        className="btn btn-ghost agent-approval-deny"
        disabled={disabled}
        onClick={() => onSudo(part, false)}
      >
        Deny
      </button>
    </div>
  );

  return (
    <CollapsibleActionCard
      title="Privilege escalation requested"
      description={reason}
      headerMeta={modeBadge}
      command={part.command ? <pre>{part.command}</pre> : null}
      // Command is always visible; Details reveals the fuller mode notice (the
      // blast-radius badge already shows collapsed).
      hasDetails={true}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((value) => !value)}
      footer={footer}
    >
      {modeNotice}
    </CollapsibleActionCard>
  );
}

/** A `secret.request` prompt. SECURITY: the entered value lives ONLY in this
 * component's local state, is sent straight to the gateway via the typed
 * `respondToSecret` method, and is wiped on submit, cancel, and unmount. It is
 * never logged, never placed on a part/event, and never echoed (the input is a
 * password field). The requested key name is redacted when it looks sensitive
 * so a token name can't leak into the transcript either. */
export function SecretPart({
  onSecret,
  onCancel,
  part,
  submitting,
}: {
  onSecret: (part: Extract<AgentChatPart, { type: "secret" }>, value: string) => void;
  onCancel?: (part: Extract<AgentChatPart, { type: "secret" }>) => void;
  part: Extract<AgentChatPart, { type: "secret" }>;
  submitting?: true;
}) {
  const [value, setValue] = useState("");
  const inputId = useId();
  const disabled = part.status !== "pending" || submitting !== undefined;
  const label = part.keyName ? redactedKeyName(part.keyName) : undefined;

  // Defense in depth: clear the entered value if the card unmounts (navigation,
  // resolution) so it never lingers in a detached React tree.
  useEffect(() => {
    return () => setValue("");
  }, []);

  function submit() {
    const entered = value;
    if (!entered) return;
    // Hand the value off, then immediately wipe local state — the value never
    // outlives the submit call here.
    onSecret(part, entered);
    setValue("");
  }

  function cancel() {
    setValue("");
    onCancel?.(part);
  }

  const keyLine = label ? (
    <p className="agent-secret-key">
      <span>Key</span>
      <code>{label}</code>
    </p>
  ) : null;

  // Resolved collapses to a quiet receipt row: "Secret provided" plus the
  // redacted key name (never the value), expandable to the reason and key.
  // SECURITY: no secret value is ever rendered here — only the reason and the
  // already-redacted key label.
  if (part.status !== "pending") {
    return (
      <ResolvedActionRow
        label="Secret provided"
        detail={label ? <span className="agent-resolved-mono">{label}</span> : undefined}
      >
        <p>{part.reason ?? "June needs a secret value before it can continue."}</p>
        {keyLine}
      </ResolvedActionRow>
    );
  }

  return (
    <article className="agent-approval-card" data-status={part.status}>
      <div>
        <div className="agent-tool-title">
          <span>Secret requested</span>
        </div>
        <p>{part.reason ?? "June needs a secret value before it can continue."}</p>
        {keyLine}
        <form
          className="agent-secret-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor={inputId} className="agent-secret-label">
            Secret value
          </label>
          <input
            id={inputId}
            type="password"
            className="dialog-input agent-secret-input"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            // The browser must never store or suggest this value.
            data-1p-ignore
            data-lpignore="true"
            disabled={disabled}
            value={value}
            placeholder="Paste the value"
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <p className="agent-secret-note">
            Sent straight to the agent and never saved, logged, or shown.
          </p>
          <div className="agent-approval-actions">
            <button type="submit" className="btn btn-secondary" disabled={disabled || !value}>
              {submitting ? "Submitting" : "Submit"}
            </button>
            <button
              type="button"
              className="btn btn-ghost agent-approval-deny"
              disabled={submitting !== undefined}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </article>
  );
}

/** Masks a requested key name when it matches the shared sensitive-key pattern
 * (TOKEN, API_KEY, SECRET, PASSWORD, PRIVATE_KEY, CREDENTIAL), so even the
 * label can't leak a token name into the transcript. Benign names (e.g.
 * GITHUB_USERNAME) pass through unchanged. */
function redactedKeyName(keyName: string) {
  return isSensitiveKey(keyName) ? "[redacted]" : keyName;
}

function AgentThinkingGroup({
  open,
  onOpenChange,
  reasoning,
  running,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reasoning: Extract<AgentChatPart, { type: "reasoning" }>[];
  running: boolean;
}) {
  const reduceMotion = useReducedMotion();
  // Collapsed by default to a short label — "Thinking" while it works, "Thought"
  // once done (terracotta while live). Expanding reveals only the reasoning
  // prose; tool/action rows render outside this disclosure.
  const reasoningText = reasoning
    .map((part) => part.text)
    .join("\n\n")
    .trim();
  return (
    <details
      className="agent-reasoning"
      data-status={running ? "running" : "completed"}
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary aria-label={running ? "Thinking" : "Thought"}>
        <span className="agent-reasoning-label-swap" aria-hidden="true">
          <AnimatePresence initial={false}>
            <motion.span
              key={running ? "thinking" : "thought"}
              className={running ? "text-shimmer shimmer" : undefined}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                // Framer Motion takes seconds; these mirror --t-fast/--t-med.
                duration: reduceMotion ? 0.1 : 0.16,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              {running ? "Thinking" : "Thought"}
            </motion.span>
          </AnimatePresence>
        </span>
        <IconChevronDownSmall size={14} className="agent-disclosure-chevron" />
      </summary>
      <div className="agent-reasoning-body">
        {reasoningText ? <div className="agent-reasoning-text">{reasoningText}</div> : null}
      </div>
    </details>
  );
}

// Tool activity is collapsed to a single quiet row by default — name + status —
// so the conversation isn't buried under raw tool output (skill dumps, command
// logs). The full output is one click away when the row has a body.
function AgentToolDisclosure({
  name,
  status,
  statusNode,
  text,
  redacted,
}: {
  name: string;
  status: string;
  statusNode: ReactNode;
  text?: string | null;
  redacted?: boolean;
}) {
  const body = text && text.trim() ? text : null;
  const summary = (expandable: boolean) => (
    <>
      {/* On hover the tool glyph cross-fades to a plain-text affordance —
       * "+" when closed, "−" when open. Text instead of svg icons: glyphs
       * render on the text baseline grid, so the swap can't hitch a pixel. */}
      <span className="agent-tool-icon">
        <IconConsoleSimple size={15} className="agent-tool-icon-glyph" />
        {expandable ? (
          <>
            <span className="agent-tool-icon-expand">+</span>
            <span className="agent-tool-icon-minimize">−</span>
          </>
        ) : null}
      </span>
      <span className="agent-tool-name">{name}</span>
      {statusNode}
      {redacted ? <span className="agent-redacted">Redacted</span> : null}
    </>
  );
  if (!body) {
    return (
      <div className="agent-tool-disclosure agent-tool-disclosure-static" data-status={status}>
        {summary(false)}
      </div>
    );
  }
  return (
    <details className="agent-tool-disclosure" data-status={status}>
      <summary>{summary(true)}</summary>
      <div className="agent-tool-output">{body}</div>
    </details>
  );
}

function AgentToolPartRow({ part }: { part: Extract<AgentChatPart, { type: "tool" }> }) {
  return (
    <AgentToolDisclosure
      name={part.name}
      status={part.status}
      text={part.text}
      statusNode={
        part.status === "running" ? (
          <span className="agent-tool-spinner" role="status" aria-label="Running" title="Running">
            <DotSpinner />
          </span>
        ) : part.status === "failed" ? (
          <span className="agent-tool-live-status" data-status="failed">
            Failed
          </span>
        ) : null
      }
    />
  );
}

// Long tool runs stop growing the transcript a row per call: past this many
// rows, settled (complete/failed) calls fold behind a single count line while
// running calls stay visible below it, so what June is doing right now is
// never hidden and failures are still called out on the fold itself.
const AGENT_TOOL_STACK_FOLD_THRESHOLD = 3;

function AgentToolStack({ parts }: { parts: Extract<AgentChatPart, { type: "tool" }>[] }) {
  const settled = parts.filter((part) => part.status !== "running");
  const folded = parts.length > AGENT_TOOL_STACK_FOLD_THRESHOLD && settled.length >= 2;
  if (!folded) {
    return (
      <div className="agent-tool-stack">
        {parts.map((tool) => (
          <AgentToolPartRow key={`tool:${tool.id}`} part={tool} />
        ))}
      </div>
    );
  }
  const running = parts.filter((part) => part.status === "running");
  const failedCount = settled.filter((part) => part.status === "failed").length;
  return (
    <div className="agent-tool-stack">
      {/* Uncontrolled like the per-row disclosures: the browser owns the open
       * state, so rows settling into the fold don't snap it shut. */}
      <details
        className="agent-tool-disclosure agent-tool-fold"
        data-status={failedCount > 0 ? "failed" : "complete"}
      >
        <summary>
          <span className="agent-tool-icon">
            <IconConsoleSimple size={15} className="agent-tool-icon-glyph" />
            <span className="agent-tool-icon-expand">+</span>
            <span className="agent-tool-icon-minimize">−</span>
          </span>
          <span className="agent-tool-name">{settled.length} actions</span>
          {failedCount > 0 ? (
            <span className="agent-tool-live-status" data-status="failed">
              {failedCount} failed
            </span>
          ) : null}
        </summary>
        <div className="agent-tool-fold-body">
          {settled.map((tool) => (
            <AgentToolPartRow key={`tool:${tool.id}`} part={tool} />
          ))}
        </div>
      </details>
      {running.map((tool) => (
        <AgentToolPartRow key={`tool:${tool.id}`} part={tool} />
      ))}
    </div>
  );
}

function AgentArtifactList({
  artifacts,
  onDownload,
  onOpen,
}: {
  artifacts: AgentArtifact[];
  onDownload?: (artifact: AgentArtifact) => void;
  onOpen?: (artifact: AgentArtifact) => void;
}) {
  if (!artifacts.length) return null;
  return (
    <div className="agent-artifact-list" aria-label="Generated files">
      {artifacts.map((artifact) => (
        <AgentArtifactCard
          key={artifact.path}
          artifact={artifact}
          onDownload={onDownload}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function AgentArtifactCard({
  artifact,
  onDownload,
  onOpen,
}: {
  artifact: AgentArtifact;
  onDownload?: (artifact: AgentArtifact) => void;
  onOpen?: (artifact: AgentArtifact) => void;
}) {
  const ArtifactIcon = fileTypeIconComponent(artifact.path);
  const summary = (
    <>
      <span className="agent-artifact-icon">
        <ArtifactIcon size={18} />
      </span>
      <div className="agent-artifact-meta">
        <span className="agent-artifact-name">{artifact.name}</span>
        {artifact.size != null ? (
          <span className="agent-artifact-size">{formatBytes(artifact.size)}</span>
        ) : null}
      </div>
    </>
  );

  return (
    <article className="agent-artifact-card">
      {onOpen ? (
        <button
          type="button"
          className="agent-artifact-open"
          aria-label={`Open ${artifact.name}`}
          onClick={() => onOpen(artifact)}
        >
          {summary}
        </button>
      ) : (
        <div className="agent-artifact-open">{summary}</div>
      )}
      {onDownload ? (
        <button
          type="button"
          className="agent-artifact-download"
          aria-label={`Download ${artifact.name}`}
          title="Download"
          onClick={() => onDownload(artifact)}
        >
          <IconArrowInbox size={16} />
        </button>
      ) : null}
    </article>
  );
}

/** What the viewer fetched for the open file. Binary or oversized files
 * resolve to `none` and fall back to the download affordance. */
type AgentArtifactPreview =
  | { kind: "loading" }
  | { kind: "image"; dataUrl: string }
  | { kind: "text"; text: string }
  | { kind: "none" };

// Files panel width — user-resizable between these bounds (and never past
// roughly half the window), remembered across sessions. The live value is
// the --agent-files-w custom property on .app-shell, which the panel, the
// main card's margin, and the composer all share.
const AGENT_FILES_WIDTH_KEY = "june:agent:files-panel-width";
const FILES_PANEL_MIN_W = 300;
const FILES_PANEL_MAX_W = 600;

function clampFilesPanelWidth(width: number) {
  const viewportCap =
    typeof window === "undefined" ? FILES_PANEL_MAX_W : Math.round(window.innerWidth * 0.48);
  const max = Math.max(FILES_PANEL_MIN_W, Math.min(FILES_PANEL_MAX_W, viewportCap));
  return Math.min(Math.max(Math.round(width), FILES_PANEL_MIN_W), max);
}

function AgentArtifactPanel({
  artifacts,
  state,
  onShowList,
  onOpen,
  onDownload,
  onClose,
}: {
  artifacts: AgentArtifact[];
  state: AgentArtifactPanelState;
  onShowList: () => void;
  onOpen: (artifact: AgentArtifact) => void;
  onDownload: (artifact: AgentArtifact) => void;
  onClose: () => void;
}) {
  const artifact = state.view === "file" ? state.artifact : null;
  const [preview, setPreview] = useState<AgentArtifactPreview>({
    kind: "loading",
  });
  const [showSource, setShowSource] = useState(false);
  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  // The slide-in entrance must run once per mount and never again. WebKit
  // replays CSS animations whenever it recreates the renderer (it does this
  // during the sidebar drag's per-frame relayout), which flashed the panel
  // mid-gesture. Once the entrance finishes, data-entered switches the
  // animation off entirely so a renderer rebuild has nothing to replay.
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  // Restore the remembered width once per panel mount. The property lives on
  // .app-shell (not this element) because the main card's slide-over margin
  // and the composer's right inset consume it too.
  useEffect(() => {
    const shell = panelRef.current?.closest(".app-shell");
    if (!(shell instanceof HTMLElement)) return;
    const stored = Number.parseInt(window.localStorage.getItem(AGENT_FILES_WIDTH_KEY) ?? "", 10);
    if (Number.isFinite(stored)) {
      shell.style.setProperty("--agent-files-w", `${clampFilesPanelWidth(stored)}px`);
    }
  }, []);

  // Drag-resize from the panel's left edge, mirroring the sidebar handle:
  // the var tracks the cursor with transitions suppressed (the
  // data-files-resizing attribute), and the final width persists on release.
  const startResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const shell = event.currentTarget.closest(".app-shell");
    const startWidth = panelRef.current?.offsetWidth;
    if (!(shell instanceof HTMLElement) || !startWidth) return;
    shell.setAttribute("data-files-resizing", "true");
    const startX = event.clientX;
    const onMove = (move: PointerEvent) => {
      const next = clampFilesPanelWidth(startWidth + (startX - move.clientX));
      shell.style.setProperty("--agent-files-w", `${next}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      shell.removeAttribute("data-files-resizing");
      const finalWidth = panelRef.current?.offsetWidth;
      if (finalWidth) {
        window.localStorage.setItem(AGENT_FILES_WIDTH_KEY, `${finalWidth}`);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }, []);

  const artifactPath = artifact?.path;
  useEffect(() => {
    setShowSource(false);
    if (!artifactPath) return;
    let cancelled = false;
    setPreview({ kind: "loading" });
    const load: Promise<AgentArtifactPreview> = isPreviewableImagePath(artifactPath)
      ? hermesBridgeFilePreview(artifactPath).then((dataUrl) =>
          dataUrl ? ({ kind: "image", dataUrl } as const) : ({ kind: "none" } as const),
        )
      : hermesBridgeFileText(artifactPath).then((text) =>
          text !== null ? ({ kind: "text", text } as const) : ({ kind: "none" } as const),
        );
    void load
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch(() => {
        if (!cancelled) setPreview({ kind: "none" });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactPath]);

  useEffect(() => {
    setQuery("");
    setFilterOpen(false);
  }, [artifactPath, state.view]);

  const markdown = artifact !== null && isMarkdownPath(artifact.path) && preview.kind === "text";

  // In the list the magnifier filters file names; on a text preview it finds
  // within the document. Images and binaries have nothing to search.
  const searchable = !artifact || preview.kind === "text";
  const filterLabel = artifact ? "Find in file" : "Filter files";

  // Find-in-file re-renders the whole document, so the highlight trails the
  // keystrokes slightly instead of re-parsing a near-2 MB file on each one.
  // Clearing syncs immediately — Esc/X should unhighlight without lag. The
  // list filter stays live; it only re-renders its rows.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    if (!query) {
      setDebouncedQuery("");
      return;
    }
    const id = window.setTimeout(() => setDebouncedQuery(query), 150);
    return () => window.clearTimeout(id);
  }, [query]);
  const docHighlight = artifact ? debouncedQuery.trim() || undefined : undefined;

  // Position-aware scroll fades on the document body (same recipe as the
  // dictation history dialog): the header has no divider, so the top fade is
  // what tells you content has scrolled up behind it.
  const bodyRef = useRef<HTMLDivElement>(null);
  const fade = useScrollFade(bodyRef);

  // Count the marks that the active view actually rendered. Markdown syntax
  // can hide source-only text (for example, a link destination), so counting
  // the raw file would make the ordinal disagree with the navigable matches in
  // Preview. A changed query, artifact, or Preview/Source mode starts again at
  // the first visible match.
  useLayoutEffect(() => {
    const matches = docHighlight
      ? bodyRef.current?.querySelectorAll<HTMLElement>("mark[data-search-match-index]")
      : undefined;
    setMatchCount(matches?.length ?? 0);
    setActiveMatchIndex(0);
  }, [artifactPath, debouncedQuery, docHighlight, preview, showSource]);

  useEffect(() => {
    if (matchCount === 0) return;
    const activeMatch = bodyRef.current?.querySelector<HTMLElement>(
      `mark[data-search-match-index="${activeMatchIndex}"]`,
    );
    activeMatch?.scrollIntoView?.({ block: "center", inline: "nearest" });
  }, [activeMatchIndex, matchCount]);

  const navigateMatches = useCallback(
    (direction: -1 | 1) => {
      if (matchCount === 0) return;
      setActiveMatchIndex((current) => (current + direction + matchCount) % matchCount);
    },
    [matchCount],
  );
  // Re-measure when the panel swaps between the artifact preview and the list,
  // or when the preview content changes (the hook re-wires its observers on the
  // element swap; this catches same-element content changes).
  useEffect(() => {
    fade.update();
  }, [fade.update, preview, state.view]);

  const q = query.trim().toLowerCase();
  const visibleArtifacts = q
    ? artifacts.filter((item) => item.name.toLowerCase().includes(q))
    : artifacts;

  return (
    <>
      <div
        className="agent-files-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize files panel"
        onPointerDown={startResize}
      />
      <aside
        ref={panelRef}
        className="agent-artifact-panel"
        aria-label="Files"
        data-entered={entered ? "true" : undefined}
        onAnimationEnd={(event) => {
          if (event.animationName === "agent-artifact-panel-in") setEntered(true);
        }}
      >
        <header className="agent-artifact-panel-bar">
          {artifact ? (
            <button
              type="button"
              className="icon-button"
              aria-label="All files"
              title="All files"
              onClick={onShowList}
            >
              <IconChevronLeftSmall size={16} />
            </button>
          ) : null}
          {searchable && filterOpen ? (
            <label className="folders-search agent-artifact-filter">
              <IconMagnifyingGlass size={14} />
              <input
                type="search"
                value={query}
                placeholder={filterLabel}
                aria-label={filterLabel}
                autoFocus
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setMatchCount(0);
                  setActiveMatchIndex(0);
                }}
                onBlur={() => {
                  if (!query.trim()) setFilterOpen(false);
                }}
                onKeyDown={(event) => {
                  if (artifact && event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.stopPropagation();
                    navigateMatches(event.shiftKey ? -1 : 1);
                    return;
                  }
                  if (event.key !== "Escape") return;
                  // Esc walks back one step at a time — clear the query,
                  // collapse the filter — before a final Esc (bubbling to
                  // the workspace listener) closes the panel.
                  event.stopPropagation();
                  if (query) setQuery("");
                  else setFilterOpen(false);
                }}
              />
              {artifact && query.trim() ? (
                <span className="agent-artifact-match-navigation">
                  <output className="agent-artifact-match-status" aria-live="polite">
                    {matchCount > 0 ? activeMatchIndex + 1 : 0} of {matchCount}
                  </output>
                  <button
                    type="button"
                    className="icon-button agent-artifact-match-button"
                    aria-label="Previous match"
                    disabled={matchCount === 0}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => navigateMatches(-1)}
                  >
                    <IconArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="icon-button agent-artifact-match-button"
                    aria-label="Next match"
                    disabled={matchCount === 0}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => navigateMatches(1)}
                  >
                    <IconArrowDown size={12} />
                  </button>
                </span>
              ) : null}
              <button
                type="button"
                className="agent-artifact-filter-clear"
                aria-label={query ? "Clear filter" : "Close filter"}
                title={query ? "Clear" : "Close"}
                // Mirrors the Esc ladder for the mouse: clear the query
                // first, then collapse back to the magnifier. mousedown is
                // suppressed so clearing doesn't blur (and collapse) the
                // field.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (query) setQuery("");
                  else setFilterOpen(false);
                }}
              >
                <IconCrossSmall size={12} />
              </button>
            </label>
          ) : (
            <h2 className="agent-artifact-panel-title">{artifact ? artifact.name : "Files"}</h2>
          )}
          {searchable && !filterOpen ? (
            <button
              type="button"
              className="icon-button"
              aria-label={filterLabel}
              title={filterLabel}
              onClick={() => setFilterOpen(true)}
            >
              <IconMagnifyingGlass size={15} />
            </button>
          ) : null}
          {artifact ? (
            <button
              type="button"
              className="icon-button"
              aria-label={`Download ${artifact.name}`}
              title="Download"
              onClick={() => onDownload(artifact)}
            >
              <IconArrowInbox size={15} />
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            aria-label="Close files"
            title="Close"
            onClick={onClose}
          >
            <IconCrossMedium size={15} />
          </button>
        </header>
        {markdown ? (
          <div className="agent-artifact-panel-mode">
            <SegmentedControl
              aria-label="File view"
              value={showSource ? "source" : "preview"}
              onValueChange={(value) => setShowSource(value === "source")}
              options={[
                { value: "preview", label: "Preview" },
                { value: "source", label: "Source" },
              ]}
            />
          </div>
        ) : null}
        {artifact ? (
          <div
            ref={bodyRef}
            className="agent-artifact-panel-body scroll-fade-mask"
            data-kind={preview.kind}
            {...fade.props}
          >
            {preview.kind === "loading" ? (
              <Spinner />
            ) : preview.kind === "image" ? (
              <img
                className="agent-artifact-panel-image"
                src={preview.dataUrl}
                alt={artifact.name}
              />
            ) : preview.kind === "text" && markdown && !showSource ? (
              <MarkdownContent
                markdown={preview.text}
                highlight={docHighlight}
                activeHighlightIndex={activeMatchIndex}
              />
            ) : preview.kind === "text" ? (
              <pre className="agent-artifact-source">
                {docHighlight
                  ? highlightText(preview.text, docHighlight, "source", {
                      activeIndex: activeMatchIndex,
                      nextIndex: 0,
                    } satisfies HighlightCursor)
                  : preview.text}
              </pre>
            ) : (
              <div className="agent-artifact-panel-empty">
                <p>No preview for this file.</p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => onDownload(artifact)}
                >
                  <IconArrowInbox size={14} />
                  Download
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div
              ref={bodyRef}
              className="agent-artifact-panel-body scroll-fade-mask"
              data-kind="list"
              {...fade.props}
            >
              {visibleArtifacts.length ? (
                <ul className="agent-artifact-panel-list">
                  {visibleArtifacts.map((item) => {
                    const ArtifactIcon = fileTypeIconComponent(item.path);
                    return (
                      <li key={item.path}>
                        <button
                          type="button"
                          className="agent-artifact-row"
                          onClick={() => onOpen(item)}
                        >
                          <span className="agent-artifact-icon">
                            <ArtifactIcon size={18} />
                          </span>
                          <span className="agent-artifact-row-name">{item.name}</span>
                          <span className="agent-artifact-row-meta">{formatBytes(item.size)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="agent-artifact-search-empty">No files match.</p>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function isPreviewableImagePath(path: string) {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}

function isMarkdownPath(path: string) {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function capabilityMatches(
  item: HermesSkillInfo | HermesToolsetInfo | HermesMessagingPlatformInfo,
  query: string,
) {
  if (!query) return true;
  const values = [
    "name" in item ? item.name : "",
    "label" in item ? item.label : "",
    "description" in item ? item.description : "",
    "category" in item ? item.category : "",
    "provider" in item ? item.provider : "",
    "state" in item ? item.state : "",
  ];
  if ("tools" in item && Array.isArray(item.tools)) {
    values.push(...item.tools);
  }
  return values.some((value) => safeText(value).toLowerCase().includes(query));
}

function filterFilesystemEntries(
  entries: HermesFilesystemEntry[],
  query: string,
): HermesFilesystemEntry[] {
  if (!query) return entries;
  return entries.flatMap((entry) => {
    const children = filterFilesystemEntries(entry.children ?? [], query);
    if (includesQuery(entry.name, query) || includesQuery(entry.path, query) || children.length) {
      return [{ ...entry, children }];
    }
    return [];
  });
}

function artifactsFromFilesystemSnapshot(
  snapshot: HermesFilesystemSnapshot | null,
): AgentArtifact[] {
  return (snapshot?.roots ?? []).flatMap((root) =>
    filesystemEntriesToArtifacts(root.entries, root.label),
  );
}

function composerInputSignatureFor({
  message,
  category,
  attachments,
  model,
}: {
  message: string;
  category: ReportCategory | null;
  attachments: AgentAttachment[];
  model?: VeniceModelDto;
}) {
  const attachmentSignature = composerAttachmentSignature(attachments);
  return [
    model?.id ?? "",
    positiveContextTokens(model?.contextTokens) ?? "",
    category ?? "",
    composerInputHash(`${message}\n${attachmentSignature}`),
  ].join(":");
}

function oversizedComposerInputWarning({
  content,
  inputSignature,
  attachments,
  model,
  models,
}: {
  content: string;
  inputSignature: string;
  attachments: AgentAttachment[];
  model?: VeniceModelDto;
  models: VeniceModelDto[];
}): ComposerInputSizeWarning | null {
  const contextLimit = positiveContextTokens(model?.contextTokens);
  if (!contextLimit) return null;

  // The composer only has attachment metadata here. Treat file bytes as a
  // conservative character proxy so large pending files still get a warning.
  const attachmentCharacterProxy = attachments.reduce(
    (total, attachment) => total + nonNegativeAttachmentSize(attachment.size),
    0,
  );
  const estimatedTokens = Math.ceil(
    (content.length + attachmentCharacterProxy) / COMPOSER_TOKEN_ESTIMATE_CHARS_PER_TOKEN,
  );
  if (estimatedTokens <= contextLimit) return null;

  const signature = [
    inputSignature,
    model?.id ?? "",
    contextLimit,
    estimatedTokens,
    composerInputHash(content),
  ].join(":");

  return {
    inputSignature,
    signature,
    estimatedTokens,
    contextLimit,
    modelName: model?.name?.trim() || "the selected model",
    switchModel: largerContextModel({
      currentModel: model,
      estimatedTokens,
      currentContextLimit: contextLimit,
      models,
    }),
  };
}

function composerAttachmentSignature(attachments: AgentAttachment[]) {
  return attachments
    .map((attachment) =>
      [
        attachment.id,
        attachment.path,
        attachment.name,
        attachment.size ?? "",
        attachment.attach.status,
      ].join("|"),
    )
    .join("\n");
}

function positiveContextTokens(value?: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function nonNegativeAttachmentSize(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function largerContextModel({
  currentModel,
  estimatedTokens,
  currentContextLimit,
  models,
}: {
  currentModel?: VeniceModelDto;
  estimatedTokens: number;
  currentContextLimit: number;
  models: VeniceModelDto[];
}) {
  const candidates = models
    .filter((model) => model.id !== currentModel?.id)
    .filter((model) => modelSupportsTools(model))
    .map((model) => ({ model, contextTokens: positiveContextTokens(model.contextTokens) }))
    .filter(
      (item): item is { model: VeniceModelDto; contextTokens: number } =>
        item.contextTokens !== undefined && item.contextTokens > currentContextLimit,
    );
  const sufficient = candidates
    .filter((item) => item.contextTokens >= estimatedTokens)
    .sort((a, b) => a.contextTokens - b.contextTokens);
  if (sufficient.length) return sufficient[0].model;
  return candidates.sort((a, b) => b.contextTokens - a.contextTokens)[0]?.model;
}

function composerInputHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function formatComposerTokenCount(value: number) {
  return value.toLocaleString();
}

function promptWithAttachments(message: string, attachments: AgentAttachment[]): string {
  if (!attachments.length) return message;
  return [
    message || "Use the attached file(s).",
    "",
    USER_ATTACHMENT_PROMPT_MARKER,
    "Attached files copied into the June workspace:",
    ...attachments.map(
      (attachment) =>
        `- ${attachment.name} (${attachment.rootLabel}): ${attachmentPromptPath(attachment.path)}`,
    ),
    "",
    "Use these file paths when inspecting or operating on the files.",
  ].join("\n");
}

function unsupportedImageInputPrompt({
  displayContent,
  imageNames,
  modelName,
  runtimeContent,
}: {
  displayContent: string;
  imageNames: string[];
  modelName?: string;
  runtimeContent: string;
}) {
  const modelLabel = modelName?.trim() || "The selected model";
  return [
    displayContent,
    "",
    "--- Attached Context ---",
    `${modelLabel} does not support image input in June.`,
    "The user attached image file(s), but this model cannot read their visual contents.",
    imageNames.length ? `Attached image file(s): ${imageNames.join(", ")}.` : undefined,
    "Do not call vision_analyze, image tools, shell, filesystem tools, or any other tool to inspect the image files.",
    "Reply directly and briefly. Say that you cannot view the attached image with the current model, then ask the user to describe the image or paste the relevant text. If they expected the image to be readable, suggest choosing a model with image support and sending the image again.",
    runtimeContent !== displayContent
      ? ["", "Original routed prompt:", runtimeContent].join("\n")
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function attachmentPromptPath(path: string) {
  const workspaceMatch = path.match(/(?:^|[/\\])workspace[/\\](.+)$/);
  if (workspaceMatch?.[1]) return workspaceMatch[1];
  return path;
}

function filesystemEntriesToArtifacts(
  entries: HermesFilesystemEntry[],
  rootLabel: string,
): AgentArtifact[] {
  return entries.flatMap((entry) => {
    const children = filesystemEntriesToArtifacts(entry.children ?? [], rootLabel);
    if (entry.kind !== "file") return children;
    return [
      {
        name: entry.name,
        path: entry.path,
        rootLabel,
        size: entry.size,
      },
      ...children,
    ];
  });
}

// Assigns each workspace file to the first turn that mentions it, so its
// download card renders once instead of at the end of every later response
// that happens to repeat the file name. User turns can claim a file too, using
// either the full artifact path or the workspace-relative path injected for
// attachments, so a file the user just handed us shouldn't bounce back as a
// download. Name-only matches are also deduplicated by name, so two workspace
// copies of the same file don't produce twin cards. A file already rendered
// inline as a generated image/video part never gets a card at all — the inline
// figure carries its own open/download affordances, and a duplicate file card
// would otherwise paint above the generation it came from (JUN-305).
function assignArtifactsToTurns(
  turns: AgentChatTurn[],
  artifacts: AgentArtifact[],
): Map<string, AgentArtifact[]> {
  const byTurn = new Map<string, AgentArtifact[]>();
  if (!artifacts.length) return byTurn;
  const claimedPaths = new Set<string>();
  const claimedNames = new Set<string>();
  const mediaPaths = new Set<string>();
  const mediaNames = new Set<string>();
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.type !== "image" && part.type !== "video") continue;
      // A path-bearing inline media part is deduped precisely by its path, so it
      // needn't also claim its basename (which would wrongly suppress an
      // unrelated later file sharing that name). Only pathless inline media
      // (e.g. MCP inline image blocks carrying just a filename) fall back to the
      // fuzzy name match.
      if (part.path) mediaPaths.add(part.path);
      else if (part.name) mediaNames.add(part.name.toLowerCase());
    }
  }
  for (const turn of turns) {
    const text = turn.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .toLowerCase();
    if (!text.trim()) continue;
    const mentioned: AgentArtifact[] = [];
    for (const artifact of artifacts) {
      const name = artifact.name.toLowerCase();
      if (!name || claimedPaths.has(artifact.path)) continue;
      if (mediaPaths.has(artifact.path) || mediaNames.has(name)) continue;
      const pathMentioned =
        text.includes(artifact.path.toLowerCase()) ||
        text.includes(attachmentPromptPath(artifact.path).toLowerCase());
      const nameMentioned =
        turn.role === "assistant" && !claimedNames.has(name) && text.includes(name);
      if (!pathMentioned && !nameMentioned) continue;
      claimedPaths.add(artifact.path);
      claimedNames.add(name);
      if (turn.role === "assistant") mentioned.push(artifact);
    }
    if (mentioned.length) byTurn.set(turn.id, mentioned);
  }
  return byTurn;
}

// The inline media renderer owns generated image and video cards, so
// assignArtifactsToTurns deliberately excludes their workspace files. The
// Files panel still needs that path-backed media: collect it beside the ordinary
// per-turn artifacts, preserving conversation order and listing each file once.
function surfacedArtifactsFromTurns(
  turns: AgentChatTurn[],
  artifactsByTurn: Map<string, AgentArtifact[]>,
  availableArtifacts: AgentArtifact[],
): AgentArtifact[] {
  const surfaced: AgentArtifact[] = [];
  const surfacedPaths = new Set<string>();
  const surfacedMediaAliases = new Map<string, string>();

  function addArtifact(artifact: AgentArtifact) {
    if (surfacedPaths.has(artifact.path)) return;
    surfacedPaths.add(artifact.path);
    surfaced.push(artifact);
  }

  for (const turn of turns) {
    for (const artifact of artifactsByTurn.get(turn.id) ?? []) addArtifact(artifact);
    for (const part of turn.parts) {
      if ((part.type !== "image" && part.type !== "video") || part.status !== "complete") {
        continue;
      }
      const mediaPath = part.path?.trim();
      if (!mediaPath) continue;
      const aliases =
        part.type === "image"
          ? generatedImagePathAliases(mediaPath, part.name)
          : generatedVideoPathAliases(mediaPath);
      const matchingArtifacts = availableArtifacts.filter(
        (artifact) => artifact.path === mediaPath,
      );
      let matchedArtifact = matchingArtifacts.length === 1 ? matchingArtifacts[0] : undefined;
      if (!matchedArtifact && part.type === "video" && isBareMediaPath(mediaPath)) {
        const aliasMatches = availableArtifacts.filter((artifact) =>
          generatedVideoPathAliases(artifact.path).some((alias) => aliases.includes(alias)),
        );
        if (aliasMatches.length === 1) matchedArtifact = aliasMatches[0];
      }
      const artifact =
        matchedArtifact ??
        ({
          name:
            part.name?.trim() || (part.type === "image" ? "Generated image" : "Generated video"),
          path: mediaPath,
          rootLabel: "Workspace",
        } satisfies AgentArtifact);
      const existingPath = aliases
        .map((alias) => surfacedMediaAliases.get(alias))
        .find((path) => path !== undefined);
      if (existingPath) {
        // A bare MEDIA reference can arrive before the filesystem snapshot or
        // a later absolute MEDIA reference. Keep the canonical path so Files
        // preview/download actions reach the native validator successfully.
        // Only video aliases are strict generated-video-<hex> filenames (1:1
        // with files); image aliases can derive from tool-supplied display
        // names, so two different files can be alias-equal — never upgrade
        // (and erase) a surfaced image row on that basis.
        let canonicalPath = existingPath;
        if (
          part.type === "video" &&
          isBareMediaPath(existingPath) &&
          !isBareMediaPath(artifact.path)
        ) {
          const index = surfaced.findIndex((item) => item.path === existingPath);
          if (index >= 0) {
            if (surfacedPaths.has(artifact.path)) surfaced.splice(index, 1);
            else {
              surfaced[index] = artifact;
              surfacedPaths.add(artifact.path);
            }
            surfacedPaths.delete(existingPath);
            for (const [alias, path] of surfacedMediaAliases) {
              if (path === existingPath) surfacedMediaAliases.set(alias, artifact.path);
            }
            canonicalPath = artifact.path;
          }
        }
        // Register this part's own aliases against the surviving row so a later
        // bare reference through an unregistered alias doesn't push a duplicate.
        for (const alias of aliases) surfacedMediaAliases.set(alias, canonicalPath);
        continue;
      }
      addArtifact(artifact);
      for (const alias of aliases) surfacedMediaAliases.set(alias, artifact.path);
    }
  }

  return surfaced;
}

function isBareMediaPath(path: string): boolean {
  return !path.replaceAll("\\", "/").includes("/");
}

export function generatedImagePathAliases(path: string, displayName?: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  if (!isBareMediaPath(path) && !/\/(?:image_cache|images)\//i.test(normalized)) return [];
  const aliases = new Set<string>();
  const pathName = normalized.split("/").at(-1);
  if (pathName) aliases.add(normalizedGeneratedImageName(pathName));
  const name = displayName?.trim();
  if (name && (/\.june-source-[^.]+(?=\.[^.]+$)/i.test(name) || /^generated-image-/i.test(name))) {
    aliases.add(normalizedGeneratedImageName(name));
  }
  return [...aliases];
}

function normalizedGeneratedImageName(name: string): string {
  return name.replace(/\.june-source-[^.]+(?=\.[^.]+$)/i, "").toLowerCase();
}

function generatedVideoPathAliases(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  if (!isBareMediaPath(path) && !/\/(?:video_cache|videos)\//i.test(normalized)) return [];
  const name = normalized.split("/").at(-1);
  return name && isGeneratedVideoFilename(name) ? [name.toLowerCase()] : [];
}

function includesQuery(value: unknown, query: string) {
  return safeText(value).toLowerCase().includes(query);
}

function mergeActiveHermesSessions(
  fresh: HermesSessionInfo[],
  current: HermesSessionInfo[],
  options: {
    selectedSessionId?: string;
    workingSessionIds: Set<string>;
    waitingSessionIds: Set<string>;
    pendingMessages: Record<string, HermesSessionMessage[]>;
    defaultModelId?: string;
  },
) {
  const currentById = new Map(current.map((session) => [session.id, session]));
  const defaultModelId = options.defaultModelId?.trim();
  const mergedFresh = fresh.map((session) => {
    if (session.model?.trim()) return session;
    const currentModel = currentById.get(session.id)?.model?.trim();
    if (currentModel) return { ...session, model: currentModel };
    return defaultModelId ? { ...session, model: defaultModelId } : session;
  });
  const seen = new Set(mergedFresh.map((session) => session.id));
  const retained = current.filter(
    (session) => !seen.has(session.id) && shouldRetainHermesSessionId(session.id, options),
  );
  return [...mergedFresh, ...retained].sort((a, b) =>
    sessionTimestamp(b).localeCompare(sessionTimestamp(a)),
  );
}

function shouldRetainHermesSessionId(
  sessionId: string,
  {
    pendingMessages,
    selectedSessionId,
    waitingSessionIds,
    workingSessionIds,
  }: {
    selectedSessionId?: string;
    workingSessionIds: Set<string>;
    waitingSessionIds: Set<string>;
    pendingMessages: Record<string, HermesSessionMessage[]>;
  },
) {
  return (
    sessionId === selectedSessionId ||
    workingSessionIds.has(sessionId) ||
    waitingSessionIds.has(sessionId) ||
    (pendingMessages[sessionId]?.length ?? 0) > 0
  );
}

// Hermes may persist timestamps with second precision while pending entries
// carry millisecond ISO strings, so allow a little backward skew when deciding
// whether a persisted message is the stored copy of a pending one.
const PENDING_MATCH_SKEW_MS = 1500;

function retainUnpersistedPendingMessages(
  pending: HermesSessionMessage[],
  persisted: HermesSessionMessage[],
) {
  return pending.filter(
    (pendingMessage) =>
      !persisted.some((message) => persistedMessageMatchesPending(message, pendingMessage)),
  );
}

function persistedMessageMatchesPending(
  persistedMessage: HermesSessionMessage,
  pendingMessage: HermesSessionMessage,
) {
  if (persistedMessage.role !== pendingMessage.role) return false;
  if (
    !sameVisibleMessageText(
      visibleHermesMessageText(persistedMessage),
      visibleHermesMessageText(pendingMessage),
    )
  ) {
    return false;
  }
  const pendingAt = hermesMessageTimestampMs(pendingMessage);
  if (pendingAt === undefined) return true;
  // Only a message persisted at/after the pending send can be its stored
  // copy - an older identical message (e.g. a re-sent "continue") must not
  // swallow the new pending entry and fake persistence for the current Agent run.
  const persistedAt = hermesMessageTimestampMs(persistedMessage);
  return persistedAt === undefined || persistedAt >= pendingAt - PENDING_MATCH_SKEW_MS;
}

function agentRunPersistenceBoundary(
  persistedMessages: HermesSessionMessage[],
  historyWasHydrated: boolean,
  submittedAtMs: number,
): AgentRunPersistenceBoundary {
  const persistedUsers = persistedMessages.filter((message) => message.role === "user");
  return {
    persistedUserIds: new Set(
      persistedUsers.flatMap((message) => (message.id ? [message.id] : [])),
    ),
    persistedUserCount: persistedUsers.length,
    historyWasHydrated,
    submittedAtMs,
  };
}

function persistedUserIsAfterAgentRunBoundary(
  persistedMessage: HermesSessionMessage,
  persistedUserIndex: number,
  boundary: AgentRunPersistenceBoundary | undefined,
) {
  if (!boundary) return true;
  if (persistedMessage.id && boundary.persistedUserIds.has(persistedMessage.id)) return false;
  if (boundary.historyWasHydrated) return persistedUserIndex >= boundary.persistedUserCount;
  const persistedAt = hermesMessageTimestampMs(persistedMessage);
  return persistedAt !== undefined && persistedAt >= boundary.submittedAtMs;
}

function persistedAssistantAfterPendingUser(
  persistedMessages: HermesSessionMessage[],
  pendingUserMessage: HermesSessionMessage,
  persistenceBoundary?: AgentRunPersistenceBoundary,
) {
  const persistedUserIndex = persistedPendingUserIndex(
    persistedMessages,
    pendingUserMessage,
    persistenceBoundary,
  );
  return (
    persistedUserIndex >= 0 &&
    hasFinalContentBearingAssistantReply(persistedMessages, persistedUserIndex)
  );
}

function persistedPendingUserIndex(
  persistedMessages: HermesSessionMessage[],
  pendingUserMessage: HermesSessionMessage,
  persistenceBoundary?: AgentRunPersistenceBoundary,
) {
  let persistedUserIndex = -1;
  let persistedUserOrdinal = 0;
  for (let index = 0; index < persistedMessages.length; index += 1) {
    const persistedMessage = persistedMessages[index];
    if (persistedMessage.role !== "user") continue;
    if (
      persistedMessageMatchesPending(persistedMessage, pendingUserMessage) &&
      persistedUserIsAfterAgentRunBoundary(
        persistedMessage,
        persistedUserOrdinal,
        persistenceBoundary,
      )
    ) {
      persistedUserIndex = index;
    }
    persistedUserOrdinal += 1;
  }
  return persistedUserIndex;
}

function hermesMessageTimestampMs(message: HermesSessionMessage) {
  const raw = message.timestamp ?? message.created_at;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") {
    // Hermes sometimes reports epoch seconds rather than milliseconds.
    return raw > 1e12 ? raw : raw * 1000;
  }
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? undefined : parsed;
}

function sessionHasAssistantAfterLatestUser(messages: HermesSessionMessage[]) {
  let latestUserIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") latestUserIndex = index;
  });
  return hasFinalContentBearingAssistantReply(messages, latestUserIndex);
}

// A session whose latest message is a recent user prompt with no assistant
// reply yet is treated as an in-flight run — e.g. the workspace was unmounted
// mid-run (navigation) or the gateway dropped — so working state and the poll
// are re-armed to catch the conversation up. The recency window keeps long-
// abandoned sessions (a trailing "thanks" from days ago) from spinning.
const RESUME_ACTIVITY_WINDOW_MS = 15 * 60 * 1000;

function shouldResumeSessionActivity(messages: HermesSessionMessage[]) {
  if (sessionHasAssistantAfterLatestUser(messages)) return false;
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  if (!latestUser) return false;
  const sentAt = hermesMessageTimestampMs(latestUser);
  return sentAt !== undefined && Date.now() - sentAt < RESUME_ACTIVITY_WINDOW_MS;
}

function persistedAssistantMessagesById(messages: HermesSessionMessage[]) {
  const persisted = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.id) continue;
    persisted.set(message.id, persistedHermesAssistantText(message));
  }
  return persisted;
}

function persistedHermesAssistantText(message: HermesSessionMessage) {
  return (
    textFromHermesTransportContent(message.content) ??
    textFromHermesTransportContent(message.text) ??
    textFromHermesTransportContent(message.context) ??
    ""
  );
}

function persistedAssistantTextsForAgentRun(
  messages: HermesSessionMessage[],
  authorityProof: AgentRunAuthorityProof,
) {
  const persistedUserIndex = persistedPendingUserIndex(
    messages,
    authorityProof.submittedUserMessage,
    authorityProof.persistenceBoundary,
  );
  if (persistedUserIndex < 0) return undefined;
  const followingRunMessages = messages.slice(persistedUserIndex + 1);
  const nextUserIndex = followingRunMessages.findIndex((message) => message.role === "user");
  const runMessages =
    nextUserIndex >= 0 ? followingRunMessages.slice(0, nextUserIndex) : followingRunMessages;
  return runMessages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    const text = persistedHermesAssistantText(message);
    return text.trim() ? [text] : [];
  });
}

/** Live `session.resume` rows come from Hermes' in-memory history projection,
 * which does not carry the database ids required by the REST normalizer. Give
 * those rows response-local identities so the atomic snapshot can still prove
 * ordering; the ids never escape this handoff calculation. */
function normalizeAtomicHermesResumeMessages(rawMessages: unknown[]) {
  return normalizeHermesSessionMessagesResponse({
    messages: rawMessages.map((message, index) => {
      if (!message || typeof message !== "object") return message;
      const id = (message as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") return message;
      return { ...message, id: `resume-snapshot:${index}` };
    }),
  });
}

/** Resolves a resume snapshot's assistant rows against the accepted Agent run.
 * A patched-runtime pending-complete ordinal may move the boundary back by one
 * exact row: that event will be delivered on the replacement transport after
 * the response. Missing, malformed, non-final, or out-of-run proof stays at the
 * snapshot's end so identical prose can never become a text-only overlap. */
function persistedAssistantRunForAtomicResume(
  messages: HermesSessionMessage[],
  authorityProof: AgentRunAuthorityProof,
  pendingCompleteAssistantOrdinal: number | undefined,
) {
  const persistedUserIndex = persistedPendingUserIndex(
    messages,
    authorityProof.submittedUserMessage,
    {
      ...authorityProof.persistenceBoundary,
      // This is the live runtime's atomic history, not a lagging REST read.
      // Its user ordinal is therefore authoritative even when a brand-new
      // session had no timestamp-bearing history before prompt acceptance.
      historyWasHydrated: true,
    },
  );
  if (persistedUserIndex < 0) return undefined;

  const followingRunMessages = messages.slice(persistedUserIndex + 1);
  const nextUserOffset = followingRunMessages.findIndex((message) => message.role === "user");
  const runEndIndex =
    nextUserOffset < 0 ? messages.length : persistedUserIndex + 1 + nextUserOffset;
  const assistantTexts: string[] = [];
  let globalAssistantOrdinal = 0;
  let pendingCompleteRunOrdinal: number | undefined;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = persistedHermesAssistantText(message);
    if (!text.trim()) continue;
    if (index > persistedUserIndex && index < runEndIndex) {
      if (globalAssistantOrdinal === pendingCompleteAssistantOrdinal) {
        pendingCompleteRunOrdinal = assistantTexts.length;
      }
      assistantTexts.push(text);
    }
    globalAssistantOrdinal += 1;
  }

  const pendingProofIsExactFinalRow =
    Number.isSafeInteger(pendingCompleteAssistantOrdinal) &&
    (pendingCompleteAssistantOrdinal ?? -1) >= 0 &&
    pendingCompleteAssistantOrdinal === globalAssistantOrdinal - 1 &&
    pendingCompleteRunOrdinal === assistantTexts.length - 1;

  return {
    assistantTexts,
    pendingCompleteRunOrdinal: pendingProofIsExactFinalRow ? pendingCompleteRunOrdinal : undefined,
  };
}

function hermesTerminalFingerprint(event: JuneHermesEvent): string | undefined {
  if (event.kind === "error") {
    return JSON.stringify(["error", event.code ?? null, event.message, event.recoverable ?? null]);
  }
  if (event.kind === "lifecycle" && event.flavor === "terminal") {
    return JSON.stringify(["lifecycle", event.status, event.text]);
  }
  return undefined;
}

const MAX_AGENT_RUN_TERMINAL_FINGERPRINTS = 64;

function appendAgentRunTerminalFingerprint(fingerprints: string[], fingerprint: string) {
  if (fingerprints.includes(fingerprint)) return fingerprints;
  return [...fingerprints, fingerprint].slice(-MAX_AGENT_RUN_TERMINAL_FINGERPRINTS);
}

function hermesTerminalFingerprints(stream: HermesLiveStream): string[] {
  let fingerprints: string[] = [];
  for (const { event } of stream.entries) {
    if (!isTerminalHermesEvent(event)) continue;
    const fingerprint = hermesTerminalFingerprint(event);
    if (fingerprint) {
      fingerprints = appendAgentRunTerminalFingerprint(fingerprints, fingerprint);
    }
  }
  return fingerprints;
}

function hermesLiveStreamHasFailedCurrentRun(
  stream: HermesLiveStream | undefined,
  afterRevision: number,
) {
  if (!stream) return false;
  for (let index = stream.entries.length - 1; index >= 0; index -= 1) {
    const entry = stream.entries[index];
    if (!entry || entry.revision <= afterRevision) continue;
    const event = entry.event;
    if (!event) continue;
    if (event.kind === "transcript" && event.complete) return event.failed;
  }
  return false;
}

export type AgentActivityLevelProjection = {
  workingSessionIds: Set<string>;
  waitingSessionIds: Set<string>;
  toolCallSessionIds: Set<string>;
};

export function projectAgentActivityLevels(
  records: AgentActivityRecord[],
  previous?: AgentActivityLevelProjection,
): AgentActivityLevelProjection {
  const workingSessionIds = new Set<string>();
  const waitingSessionIds = new Set<string>();
  const toolCallSessionIds = new Set<string>();
  for (const record of records) {
    if (record.pendingActionCount > 0 || record.phase === "waiting") {
      waitingSessionIds.add(record.sessionId);
    } else if (record.phase === "running" || record.phase === "background") {
      workingSessionIds.add(record.sessionId);
    }
    if (record.currentTool) {
      toolCallSessionIds.add(record.sessionId);
    }
  }
  return {
    workingSessionIds: stableSet(workingSessionIds, previous?.workingSessionIds),
    waitingSessionIds: stableSet(waitingSessionIds, previous?.waitingSessionIds),
    toolCallSessionIds: stableSet(toolCallSessionIds, previous?.toolCallSessionIds),
  };
}

function stableSet(next: Set<string>, previous: Set<string> | undefined): Set<string> {
  if (!previous || previous.size !== next.size) return next;
  for (const value of next) {
    if (!previous.has(value)) return next;
  }
  return previous;
}

function agentActivityCountsFromStore() {
  const projection = projectAgentActivityLevels(hermesActivityStore.getRecords());
  return {
    activeCount: projection.workingSessionIds.size + projection.waitingSessionIds.size,
    needsUserCount: projection.waitingSessionIds.size,
  };
}

function lifecycleStatusLooksRunning(event: Extract<JuneHermesEvent, { kind: "lifecycle" }>) {
  return event.flavor === "running";
}

function agentStatusFromHermesEvent(
  event: JuneHermesEvent,
  hasOpenPendingAction = false,
): AgentSessionStatusKind | undefined {
  if (event.kind === "error") return "failed";
  if (event.kind === "pending_action") return "waitingForUser";
  if (event.kind === "pending_action_resolution" || event.kind === "pending_action_expiration") {
    return hasOpenPendingAction ? "waitingForUser" : "running";
  }
  // A complete transcript closes one assistant message, not the Agent run.
  // The owning listener or monitor settles the run from lifecycle and
  // persistence evidence so replayed message boundaries cannot finish it.
  if (event.kind === "lifecycle" && event.flavor === "terminal") {
    const status = event.status.toLowerCase();
    if (/(?:cancel|stop|interrupt|abort)/.test(status)) return "cancelled";
    if (/(?:fail|error|timeout)/.test(status)) return "failed";
    return "completed";
  }
  if (
    event.kind === "tool" ||
    event.kind === "reasoning" ||
    // Only a turn START flips status (delta === undefined). Text deltas never
    // re-dispatched status on the raw path either — per-chunk dispatch would
    // churn app state on every streamed token.
    (event.kind === "transcript" && !event.complete && event.delta === undefined) ||
    (event.kind === "lifecycle" && lifecycleStatusLooksRunning(event))
  ) {
    return "running";
  }
  return undefined;
}

function agentStatusSummaryFromHermesEvent(event: JuneHermesEvent, status: AgentSessionStatusKind) {
  if (status === "waitingForUser") {
    if (event.kind !== "pending_action") return "June has a question.";
    // Sudo and secret deliberately keep the generic sentence for visible-copy parity with main.
    return event.action.kind === "approval" ? "June needs approval." : "June has a question.";
  }
  if (status === "completed") return "June finished.";
  if (status === "failed") {
    return event.kind === "error" ? event.message || "June hit a problem." : "June hit a problem.";
  }
  if (event.kind === "lifecycle") {
    return event.text || "June is working.";
  }
  if (event.kind === "tool") {
    return toolActivitySentence(event.name, event.sanitizedPayload);
  }
  if (event.kind === "reasoning") {
    return "Thinking.";
  }
  return "June is working.";
}

function visibleHermesMessageText(message: HermesSessionMessage | undefined) {
  if (!message) return "";
  const text = textFromHermesContent(message.content) ?? textFromHermesContent(message.text) ?? "";
  return displayedComposerUserMessageText(stripHermesVisibleContext(text));
}

function isResolvedSkillSlashResolution(
  resolution: SkillSlashResolution,
): resolution is Extract<SkillSlashResolution, { status: "resolved" }> {
  return resolution.status === "resolved";
}

function sameAgentAttachments(left: AgentAttachment[], right: AgentAttachment[]) {
  return (
    left.length === right.length &&
    left.every((attachment, index) => attachment.id === right[index]?.id)
  );
}

/** Short, sentence-case status word for an attachment chip (feature 19). Empty
 * for the resting imported/pending states — the chip already reads as "ready";
 * only the terminal attached/failed states earn a label. No dashes. */
function attachmentStatusLabel(state: HermesAttachmentState): string {
  switch (state.status) {
    case "attached":
      return "Attached";
    case "failed":
      return "Couldn't attach";
    default:
      return "";
  }
}

function attachmentFileTypeLabel(name: string): string {
  const filename = name.split(/[\\/]/).pop() ?? name;
  const extensionIndex = filename.lastIndexOf(".");
  if (extensionIndex <= 0 || extensionIndex === filename.length - 1) return "File";
  return filename.slice(extensionIndex + 1).toUpperCase();
}

function AgentAttachmentTile({
  attachment,
  onRemove,
}: {
  attachment: AgentAttachment;
  onRemove?: () => void;
}) {
  const statusLabel = attachmentStatusLabel(attachment.attach);
  return (
    <span
      className="agent-attachment-chip"
      data-kind={attachment.previewDataUrl ? "image" : "file"}
      data-attach-status={attachment.attach.status}
      title={attachment.attach.error ?? attachment.name}
    >
      {attachment.previewDataUrl ? (
        <img src={attachment.previewDataUrl} alt="" aria-hidden="true" />
      ) : (
        <>
          <span className="agent-attachment-file-icon" aria-hidden="true">
            <FileTypeIcon name={attachment.name} size={18} />
          </span>
          <span className="agent-attachment-file-details">
            <span className="agent-attachment-name">{attachment.name}</span>
            <span className="agent-attachment-file-meta">
              <span className="agent-attachment-file-type">
                {attachmentFileTypeLabel(attachment.name)}
              </span>
              {statusLabel ? (
                <span
                  className="agent-attachment-status"
                  data-attach-status={attachment.attach.status}
                >
                  {statusLabel}
                </span>
              ) : null}
            </span>
          </span>
        </>
      )}
      {attachment.previewDataUrl ? (
        <span className="agent-attachment-name">{attachment.name}</span>
      ) : null}
      {attachment.previewDataUrl && statusLabel ? (
        <span className="agent-attachment-status" data-attach-status={attachment.attach.status}>
          {statusLabel}
        </span>
      ) : null}
      {onRemove ? (
        <button type="button" aria-label={`Remove ${attachment.name}`} onClick={onRemove}>
          {attachment.previewDataUrl ? <IconCrossMedium size={14} /> : <IconCrossSmall size={12} />}
        </button>
      ) : null}
    </span>
  );
}

function commandTokensForResolutions(
  commandNames: string[],
  tokens: Array<{ name: string; from: number; to: number }>,
) {
  return commandNames
    .map((name) => tokens.find((token) => slashCommandKey(token.name) === slashCommandKey(name)))
    .filter((token): token is { name: string; from: number; to: number } => Boolean(token));
}

function slashCommandKey(name: string) {
  return name.trim().toLowerCase();
}

function sameVisibleMessageText(left: string, right: string) {
  return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
}

function stripHermesVisibleContext(value: string) {
  const withoutProjectContext = stripProjectContext(value);
  const withoutWarnings = withoutProjectContext.replace(/\n*--- Context Warnings ---[\s\S]*$/m, "");
  const marker = withoutWarnings.search(/\n*--- Attached Context ---/m);
  const visible = marker >= 0 ? withoutWarnings.slice(0, marker) : withoutWarnings;
  // Drop the scheduled-run delivery preamble so a routine's title and dedup
  // key come from its actual prompt, not the cron scaffolding.
  return stripScheduledRunPreamble(visible.trim());
}

function compactPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

/** Whether a snapshot entry carries an absolute path we can reveal in Finder
 * (posix "/…" or a Windows drive/UNC path). Reveal is hidden otherwise. */
function isAbsolutePath(path: string | undefined | null): path is string {
  if (!path) return false;
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function formatBytes(value: number | null | undefined) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function safeText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function toolNames(toolset: HermesToolsetInfo) {
  return Array.isArray(toolset.tools) ? toolset.tools : [];
}

export function stateLabel(value: string) {
  return value.replaceAll("_", " ");
}

/** A meaningful capability status word for the list meta line, or undefined.
 * The row's switch already conveys enabled/disabled, so those (and the neutral
 * "unknown"/"configured" placeholders) are dropped to avoid a redundant word;
 * only states that carry real information (e.g. connected, needs setup, error)
 * survive, sentence-cased. */
export function meaningfulCapabilityStatus(state: string): string | undefined {
  const normalized = state.trim().toLowerCase();
  const redundant = new Set(["enabled", "disabled", "unknown", "configured", ""]);
  if (redundant.has(normalized)) return undefined;
  const label = stateLabel(normalized);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function envFieldSet(field: HermesMessagingEnvVarInfo) {
  return Boolean(field.isSet ?? field.is_set);
}

function fieldLabel(field: HermesMessagingEnvVarInfo) {
  return field.prompt || field.key.replaceAll("_", " ").toLowerCase();
}

export function messagingTrimEdits(edits: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(edits)
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value.length > 0),
  );
}

function ActivityIndicator({
  active,
  large = false,
  status = "running",
}: {
  active: boolean;
  large?: boolean;
  status?: "running" | "waitingForUser";
}) {
  if (!active) return null;
  return (
    <span className="agent-activity-indicator" data-large={large} data-status={status}>
      <span aria-hidden="true" />
      {status === "waitingForUser" ? "Needs you" : "Working"}
    </span>
  );
}

function taskActivitySummary(task: AgentTaskDto) {
  switch (task.status) {
    case "queued":
      return "Starting work.";
    case "running":
      return task.progressSummary || "Working now.";
    default:
      return "";
  }
}

function DownloadToastMessage({ action, fileName }: { action: string; fileName: string }) {
  const label = `${action} ${fileName}`;
  return (
    <span className="june-download-toast-message" aria-label={label}>
      <span className="june-download-toast-action">{action}</span>
      <span className="june-download-toast-file" title={fileName}>
        {fileName}
      </span>
    </span>
  );
}

function ensureDownloadFileExtension(fileName: string, fallbackExtension: string) {
  const trimmed = fileName.trim();
  if (!trimmed) return `download.${fallbackExtension}`;
  if (/\.[^./\\]+$/.test(trimmed)) return trimmed;
  return `${trimmed}.${fallbackExtension}`;
}

function relativeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

// FileReader instead of Blob.arrayBuffer(): same everywhere a drop can land
// (WKWebView and jsdom included).
function readFileBytes(file: File) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the dropped file."));
    reader.readAsArrayBuffer(file);
  });
}

function omitRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function moveRecordKey<T>(record: Record<string, T[]>, from: string, to: string) {
  const moved = record[from] ?? [];
  const existing = record[to] ?? [];
  const next = { ...record };
  delete next[from];
  if (moved.length || existing.length) {
    next[to] = [...existing, ...moved];
  } else {
    delete next[to];
  }
  return next;
}

function moveHermesLiveStreamKey(
  record: Record<string, HermesLiveStream>,
  from: string,
  to: string,
) {
  const next = { ...record };
  const moved = record[from];
  delete next[from];
  if (!moved) return next;

  let combined = record[to] ?? createHermesLiveStream();
  for (const event of hermesLiveEvents(moved)) {
    combined = appendHermesLiveEvent(combined, {
      ...event,
      sessionId: to,
    } as JuneHermesEvent);
  }
  next[to] = combined;
  return next;
}

// Survives app restarts (localStorage, not sessionStorage): restoring an
// existing conversation after a relaunch is always safe, unlike the pending
// new-session marker, which must NOT outlive its navigation.
const AGENT_LAST_OPEN_SESSION_KEY = "june:agent:last-open-session";

// How long a second startNewTask call with the same prompt counts as an echo
// of the first (marker + window event double-delivery) rather than a new ask.
// The echo lands a setTimeout(0) after the mount — milliseconds — so 1s is
// already generous. It must stay time-bounded rather than clear when the
// submission settles: a fast settle would otherwise reopen the window before
// the echo arrives. User retries are unaffected either way — a failed
// auto-submit restores the draft and re-sends go through submit(), which
// never routes through this guard.
const AUTO_SUBMIT_ECHO_WINDOW_MS = 1_000;

function readLastOpenSessionId(): string | undefined {
  try {
    return window.localStorage.getItem(AGENT_LAST_OPEN_SESSION_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Drops the stored id only when it points at the given session, so deleting
 * a background session doesn't forget the one actually open. */
function forgetLastOpenSessionId(sessionId: string) {
  try {
    if (readLastOpenSessionId() === sessionId) {
      window.localStorage.removeItem(AGENT_LAST_OPEN_SESSION_KEY);
    }
  } catch {
    // Storage can be unavailable in restricted webviews; restore is best-effort.
  }
}

function writeLastOpenSessionId(sessionId: string) {
  try {
    window.localStorage.setItem(AGENT_LAST_OPEN_SESSION_KEY, sessionId);
  } catch {
    // Storage can be unavailable in restricted webviews; restore is best-effort.
  }
}

export function markAgentNewSessionPending(
  prompt?: string,
  options?: { category?: ReportCategory; noteRef?: NoteReferenceInput },
) {
  try {
    const payload = JSON.stringify({
      createdAt: Date.now(),
      prompt: prompt?.trim() || undefined,
      category: options?.category,
      noteRef: options?.noteRef,
    });
    window.sessionStorage.setItem(AGENT_NEW_SESSION_PENDING_KEY, payload);
  } catch {
    // Session storage can be unavailable in restricted webviews; the event path
    // still handles already-mounted Agent workspaces.
  }
}

// A pending marker is a navigation hint, not a durable command: it's written
// just before switching to the Agent view and consumed by the very next
// mount. Anything older is a leftover from a reload or crash — acting on it
// would hijack whatever the user had open into a new session (and re-submit
// the stale prompt).
const AGENT_NEW_SESSION_PENDING_TTL_MS = 15_000;

/** Non-consuming peek at the pending marker, for state init on a fresh
 * mount. The mount effect still consumes it via pendingNewSessionRequest();
 * peeking here must not clear it, or the auto-submit prompt would be lost. */
function hasPendingNewSessionRequest(): boolean {
  try {
    const value = window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY);
    if (value == null) return false;
    const parsed = JSON.parse(value) as { createdAt?: number };
    return (
      typeof parsed.createdAt === "number" &&
      Date.now() - parsed.createdAt <= AGENT_NEW_SESSION_PENDING_TTL_MS
    );
  } catch {
    return false;
  }
}

function parsePendingNoteRef(value: unknown): NoteReferenceInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { id?: unknown; title?: unknown };
  if (typeof record.id !== "string" || record.id.trim().length === 0) return undefined;
  return {
    id: record.id,
    title: typeof record.title === "string" ? record.title : "",
  };
}

export function pendingNewSessionRequest(): AgentNewSessionDetail | undefined {
  try {
    const value = window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY);
    if (value == null) return undefined;
    // Consume on read so a remount (HMR, rapid view switches) can't re-fire
    // the same request.
    clearPendingNewSessionRequest();
    try {
      const parsed = JSON.parse(value) as {
        createdAt?: number;
        prompt?: string;
        category?: string;
        noteRef?: unknown;
      };
      if (
        typeof parsed.createdAt !== "number" ||
        Date.now() - parsed.createdAt > AGENT_NEW_SESSION_PENDING_TTL_MS
      ) {
        return undefined;
      }
      const category = isReportCategory(parsed.category) ? parsed.category : undefined;
      const noteRef = category ? undefined : parsePendingNoteRef(parsed.noteRef);
      return {
        ...(typeof parsed.prompt === "string" ? { prompt: parsed.prompt } : {}),
        ...(category ? { category } : {}),
        ...(noteRef ? { noteRef } : {}),
      };
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

function clearPendingNewSessionRequest() {
  try {
    window.sessionStorage.removeItem(AGENT_NEW_SESSION_PENDING_KEY);
  } catch {
    // Session storage can be unavailable in restricted webviews.
  }
}
