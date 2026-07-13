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
import { IconCheckmark2Medium } from "central-icons/IconCheckmark2Medium";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconClipboard } from "central-icons/IconClipboard";
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
import type { FundingTier } from "../account/FundingNotice";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { HoverTip } from "../ui/HoverTip";
import { InlineNotice } from "../ui/InlineNotice";
import { SegmentedControl } from "../ui/SegmentedControl";
import { toast } from "../ui/Toaster";
import { Spinner } from "../ui/Spinner";
import { Switch } from "../ui/Switch";
import {
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
  retryAgentTask,
  imagePromptMayBeExplicit,
  revealPath,
  setHermesAgentCliAccess,
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
} from "../../lib/tauri";
import {
  deleteHermesSession,
  listHermesSessionMessages,
  listHermesSessions,
  sessionTimestamp,
  stripScheduledRunPreamble,
  titleFromPrompt,
} from "../../lib/hermes-adapter";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_GALLERY_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_SESSIONS_CHANGED_EVENT,
  dispatchAgentSessionsChanged,
  dispatchAgentSessionStatus,
  type AgentGalleryDetail,
  type AgentSessionsChangedDetail,
  type AgentSessionStatusKind,
} from "../../lib/agent-events";
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
  rememberSessionExchangeTitled,
  rememberSessionManuallyTitled,
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
import { useScrollFade } from "../../lib/use-scroll-fade";
import { unsupportedEventStore } from "../../lib/hermes-unsupported-events";
import { pendingActionStore } from "../../lib/hermes-pending-actions";
import { hermesActivityStore, type AgentActivityRecord } from "../../lib/hermes-activity-store";
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
import { MarkdownContent, highlightText } from "./MarkdownContent";
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
  MODEL_CHANGE_LOCKED_NOTICE,
  MODEL_SWITCH_DEFAULT_ONLY_NOTICE,
} from "../../lib/hermes-model-switch";
import {
  LOCAL_GENERATION_OPTION_ID_PREFIX,
  isLoopbackUrl,
  localGenerationOptionId,
  rawLocalGenerationModelId,
  withLocalGenerationOption,
} from "../../lib/local-generation";
import { autoPillDesignation, preferredVisionFallbackModel } from "../../lib/suggested-models";
import {
  AUTO_MODEL_ID,
  modelOptions,
  selectedModel as selectedModelOption,
} from "../settings/ModelPickerDialog";
import { ModelPickerPopover, type ModelPickerFlyout } from "../settings/ModelPickerPopover";
import {
  HERMES_SERVER_ERROR_MESSAGE,
  describeHermesError,
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
import { hermesConnectionForMode } from "../../lib/hermes-connection";
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
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
  displayedComposerUserMessageText,
  textFromHermesContent,
  type AgentApprovalChoice,
  type AgentChatPart,
  type AgentChatTurn,
} from "../../lib/agent-chat-runtime";
import { toolActivitySentence } from "../../lib/agent-tool-labels";
import {
  buildAgentChatGallery,
  buildAgentErrorGallery,
  type AgentChatGallerySection,
} from "../../lib/agent-chat-gallery";
import { attachScrollThumbFade } from "../../lib/scroll-thumb-fade";

const POLLED_STATUSES = new Set<AgentTaskStatus>(["queued", "running", "waitingForUser"]);
const AGENT_TITLE_TIMEOUT_MS = 2500;
const AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const AGENT_WORKSPACE_MAX_SESSION_RETRY_DELAY_MS =
  AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS[AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS.length - 1] ??
  2000;
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
function sampleImageBytes(): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 320;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 480, 320);
    gradient.addColorStop(0, "#936862");
    gradient.addColorStop(1, "#f4e3d7");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 480, 320);
    context.fillStyle = "rgba(255, 255, 255, 0.92)";
    context.font = "600 28px sans-serif";
    context.fillText("june-sample.png", 24, 168);
  }
  const base64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
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
  averageExecutionMs?: number;
  executionMs?: number;
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
    | "averageExecutionMs"
    | "executionMs"
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
          averageExecutionMs: turn.averageExecutionMs,
          executionMs: turn.executionMs,
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
          averageExecutionMs:
            typeof candidate.averageExecutionMs === "number"
              ? candidate.averageExecutionMs
              : undefined,
          executionMs:
            typeof candidate.executionMs === "number" ? candidate.executionMs : undefined,
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

type PreparedComposerSubmission = {
  displayContent: string;
  runtimeContent: string;
  titleContent: string;
  typedMessage: string;
};

type QueuedAttachmentFollowUp = {
  id: string;
  prepared: PreparedComposerSubmission;
  attachments: AgentAttachment[];
  status: "queued" | "sending" | "failed";
  error?: string;
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

// Every follow-up shape the queue can hold: a single-image message and a
// multi-attachment message led by a file, so the tile well, the thumbnail,
// and the overflow count all render at once.
function buildUpNextDemoFollowUps(): QueuedAttachmentFollowUp[] {
  return [
    {
      id: "attachment-follow-up-demo",
      prepared: buildUpNextDemoPrepared("Review this attachment next"),
      attachments: [buildUpNextDemoImageAttachment("attachment-demo-image", "reference.png")],
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
  /** Opens the change-project dialog (which also owns removal) for the given
   * stored session id. */
  onMoveSessionToProject?: (sessionId: string) => void;
  creditActionsDisabledReason?: string;
  /** The persistent out-of-credits notice, pre-wired by App. When present it
   * replaces the plain composer-notice paragraph; the disabled reason keeps
   * gating actions and tooltips. */
  fundingNotice?: ReactNode;
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
  liveEvents: Record<string, JuneHermesEvent[]>;
  titleOverrides: Record<string, string>;
  titleSources: Record<string, AgentSessionTitleSource>;
  pendingIssueReports: Record<string, PendingIssueReport>;
  reviewableIssueReports: Record<string, PendingIssueReport>;
  diagnosisRefreshIssueReportSessionIds: string[];
  submittingIssueReportSessionIds: string[];
  queuedAttachmentFollowUps: Record<string, QueuedAttachmentFollowUp[]>;
};

type AgentSessionTitleSource = "prompt" | "exchange" | "manual";

type IssueReportDeliveryResult = { sent: true } | { sent: false; errorMessage: string };

type IssueReportDeliverySettledDetail = {
  sessionId: string;
  report: PendingIssueReport;
  result: IssueReportDeliveryResult;
};

type IssueReportFollowUpSubmitFailedDetail = {
  sessionId: string;
  queuedReport: PendingIssueReport;
  restoreReport?: PendingIssueReport;
};

let sessionContinuity: AgentSessionContinuity | null = null;
const NEW_SESSION_DRAFT_KEY = "new-session";
const NEW_SESSION_DRAFT_STORAGE_KEY = "june:agent:new-session-draft";
const REVIEWABLE_ISSUE_REPORTS_STORAGE_KEY = "june:agent:reviewable-issue-reports";
const IMAGE_SLASH_TURNS_STORAGE_KEY = "june:agent:image-slash-turns";
const VIDEO_SLASH_TURNS_STORAGE_KEY = "june:agent:video-slash-turns";
const ISSUE_REPORT_DELIVERY_SETTLED_EVENT = "june-agent-issue-report-delivery-settled";
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

function shouldOpenNewSessionOnMount() {
  return hasPendingNewSessionRequest() || hasNewSessionComposerDraft();
}

function captureSessionContinuity(state: {
  sessionItems: HermesSessionInfo[];
  pendingMessages: Record<string, HermesSessionMessage[]>;
  runtimeSessionIds: Record<string, string>;
  liveEvents: Record<string, JuneHermesEvent[]>;
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
  if (activeIds.size === 0) return null;
  const pick = <T,>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([sessionId]) => activeIds.has(sessionId)));
  return {
    sessionItems: state.sessionItems.filter((session) => activeIds.has(session.id)),
    pendingMessages: pick(state.pendingMessages),
    runtimeSessionIds: pick(state.runtimeSessionIds),
    liveEvents: pick(state.liveEvents),
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
  if (!sessionContinuity) return;
  const reviewableIssueReports = {
    ...sessionContinuity.reviewableIssueReports,
  };
  const pendingIssueReports = { ...sessionContinuity.pendingIssueReports };
  const diagnosisRefreshIssueReportSessionIds = new Set(
    sessionContinuity.diagnosisRefreshIssueReportSessionIds,
  );
  if (detail.result.sent && reviewableIssueReports[detail.sessionId] === detail.report) {
    delete reviewableIssueReports[detail.sessionId];
    diagnosisRefreshIssueReportSessionIds.delete(detail.sessionId);
  } else if (!detail.result.sent && !pendingIssueReports[detail.sessionId]) {
    reviewableIssueReports[detail.sessionId] =
      reviewableIssueReports[detail.sessionId] ?? detail.report;
  }
  persistReviewableIssueReports(reviewableIssueReports);
  sessionContinuity = captureSessionContinuity({
    sessionItems: sessionContinuity.sessionItems,
    pendingMessages: sessionContinuity.pendingMessages,
    runtimeSessionIds: sessionContinuity.runtimeSessionIds,
    liveEvents: sessionContinuity.liveEvents,
    titleOverrides: sessionContinuity.titleOverrides,
    titleSources: sessionContinuity.titleSources,
    pendingIssueReports,
    reviewableIssueReports,
    diagnosisRefreshIssueReportSessionIds,
    submittingIssueReportSessionIds: new Set(
      sessionContinuity.submittingIssueReportSessionIds.filter(
        (sessionId) => sessionId !== detail.sessionId,
      ),
    ),
    queuedAttachmentFollowUps: sessionContinuity.queuedAttachmentFollowUps,
  });
}

function updateContinuityAfterIssueReportFollowUpSubmitFailed(
  detail: IssueReportFollowUpSubmitFailedDetail,
) {
  if (!sessionContinuity) return;
  const pendingIssueReports = { ...sessionContinuity.pendingIssueReports };
  if (pendingIssueReports[detail.sessionId] === detail.queuedReport) {
    delete pendingIssueReports[detail.sessionId];
  }
  const reviewableIssueReports = {
    ...sessionContinuity.reviewableIssueReports,
  };
  if (detail.restoreReport && !reviewableIssueReports[detail.sessionId]) {
    reviewableIssueReports[detail.sessionId] = detail.restoreReport;
  }
  persistReviewableIssueReports(reviewableIssueReports);
  sessionContinuity = captureSessionContinuity({
    sessionItems: sessionContinuity.sessionItems,
    pendingMessages: sessionContinuity.pendingMessages,
    runtimeSessionIds: sessionContinuity.runtimeSessionIds,
    liveEvents: sessionContinuity.liveEvents,
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
  updateContinuityAfterIssueReportDelivery(detail);
  window.dispatchEvent(
    new CustomEvent<IssueReportDeliverySettledDetail>(ISSUE_REPORT_DELIVERY_SETTLED_EVENT, {
      detail,
    }),
  );
}

function dispatchIssueReportFollowUpSubmitFailed(detail: IssueReportFollowUpSubmitFailedDetail) {
  updateContinuityAfterIssueReportFollowUpSubmitFailed(detail);
  window.dispatchEvent(
    new CustomEvent<IssueReportFollowUpSubmitFailedDetail>(
      ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT,
      { detail },
    ),
  );
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
  sessionContinuity = null;
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

/** Translates a catalog model id to the id Hermes understands: the synthetic
 * local option id becomes the raw local model id (the only id the provider
 * proxy advertises on /v1/models); every other id passes through. Every model
 * id sent to Hermes — session.create, session ensure, /model dispatch — must
 * cross this boundary, or a session would carry the prefixed synthetic id
 * that no provider recognizes once local mode is off. */
function hermesModelIdFor(modelId: string): string {
  return rawLocalGenerationModelId(modelId) ?? modelId;
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

export function AgentWorkspace({
  initialSession,
  initialSessionId: initialSessionIdProp,
  origin,
  onSessionSelected,
  onTopUp,
  topUpLabel = "Upgrade",
  sessionInProject = false,
  onMoveSessionToProject,
  creditActionsDisabledReason,
  fundingNotice,
  fundingTier,
  testOnlySlashCommandEntriesRef,
}: AgentWorkspaceProps = {}) {
  const initialSessionId = initialSession?.id ?? initialSessionIdProp;
  // Read once per mount (lazy initializer): the continuity snapshot the
  // previous mount captured on unmount, if any session was still mid-run.
  const [continuity] = useState(() => sessionContinuity);
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
  const [selectedHermesSessionId, setSelectedHermesSessionId] = useState<string | undefined>(
    () => initialSessionId ?? (startInNewSessionMode ? undefined : readLastOpenSessionId()),
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
  const pendingSteerBySessionIdRef = useRef<
    Record<string, { text: string; accepted: boolean; toolDrained: boolean }[]>
  >({});
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
                status: "failed" as const,
                error: "Delivery was interrupted. Try again.",
              }
            : item,
        ),
      ]),
    ),
  );
  const queuedAttachmentFollowUpsRef = useRef(queuedAttachmentFollowUps);
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
  // Completion is observable through the live gateway and both message-refresh
  // paths. Only one of them may advance queued follow-ups for a finished turn.
  const continuingCompletedTurnSessionIdsRef = useRef(new Set<string>());
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
  const defaultGenerationModelIdRef = useRef("");
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
  const [generationProvider, setGenerationProvider] = useState("venice");
  const generationProviderRef = useRef("venice");
  // Two-step confirm for enabling a NON-loopback local endpoint from the
  // composer (requests would leave the device, so no path may enable one
  // silently — Settings has the same invariant with its "Enable anyway"
  // affordance). Holds the exact base URL the warning was shown for: a second
  // selection only proceeds while the saved URL still matches, so editing the
  // endpoint in Settings re-arms the warning. Loopback endpoints never arm it.
  const localEnableConfirmArmedForRef = useRef<string | null>(null);
  const [composerModelOpen, setComposerModelOpen] = useState(false);
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
  // Dev-only sample files seeded by window.__agentFiles — surfaced alongside
  // the conversation's own artifacts so the viewer can be exercised at will.
  const [devArtifacts, setDevArtifacts] = useState<AgentArtifact[]>([]);
  const [approvalSubmitting, setApprovalSubmitting] = useState<
    Partial<Record<string, AgentApprovalChoice>>
  >({});
  const [clarifySubmitting, setClarifySubmitting] = useState<Record<string, string>>({});
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
  const composerEditorRef = useRef<ComposerEditorHandle | null>(null);
  const composerTiptapEditorRef = useRef<TiptapEditor | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
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

  function recordSessionErrorActivity(sessionId: string, message: string) {
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
  const composerModelLocked =
    !!selectedHermesSessionId && !newSessionMode && !selectedHermesSessionIsProvisional;
  // When local generation is the active provider, the pill/selection is the
  // synthetic local option so it renders "Local: <id>" and never a raw id or a
  // stale remote override. Every session routes through the local endpoint.
  const localOptionId =
    localGeneration.modelId.trim().length > 0
      ? localGenerationOptionId(localGeneration.modelId)
      : "";
  const localGenerationActive = generationProvider === "local" && localOptionId.length > 0;
  const sessionOrDefaultModelId =
    selectedHermesSessionId && !newSessionMode
      ? selectedHermesSession?.model?.trim() || defaultGenerationModelId
      : defaultGenerationModelId;
  // A local model id (synthetic or raw) can linger on a session row after
  // local is turned off; fall back to the remote default so the pill matches
  // what the remote proxy actually serves (its stale-local guard degrades
  // exactly these ids to the global model).
  const staleLocalModelId =
    !localGenerationActive &&
    (sessionOrDefaultModelId.startsWith(LOCAL_GENERATION_OPTION_ID_PREFIX) ||
      (localGeneration.modelId.trim().length > 0 &&
        sessionOrDefaultModelId === localGeneration.modelId.trim()));
  const activeGenerationModelId = localGenerationActive
    ? localOptionId
    : staleLocalModelId
      ? defaultGenerationModelId
      : sessionOrDefaultModelId;
  // Catalog surfaced in the composer picker: the remote models plus, when a
  // local endpoint is configured, the synthetic local option (even while
  // remote is active, so the user can switch to local from the composer).
  const generationModelOptions = useMemo(
    () => withLocalGenerationOption(generationModels, localGeneration),
    [generationModels, localGeneration],
  );
  const generationModel = useMemo(
    () =>
      activeGenerationModelId
        ? selectedModelOption(generationModelOptions, activeGenerationModelId)
        : undefined,
    [activeGenerationModelId, generationModelOptions],
  );
  const generationPrivacyBadge = generationModel ? modelPrivacyBadge(generationModel) : undefined;
  // The model the image-attach banner offers to switch to: a vision + tool
  // capable model, preferring a curated suggested pick (Kimi K2.6) over the
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
    ? composerModelLocked
      ? `${resolvedGenerationModel?.name ?? "This model"} can't read images. Start a new session with a vision model before using /image.`
      : `${resolvedGenerationModel?.name ?? "This model"} can't read images. Switch to a vision model before using /image.`
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
  const selectedQueuedAttachmentFollowUps = selectedHermesSessionId
    ? (queuedAttachmentFollowUps[selectedHermesSessionId] ?? [])
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
  }, [composerModelOpen, composerModelFlyout]);

  useLayoutEffect(() => {
    if (composerModelOpen && composerModelFlyout?.kind === "all") {
      composerModelSearchRef.current?.focus();
    }
  }, [composerModelFlyout, composerModelOpen]);

  // The popover lives outside the composer box (whose overflow:hidden would
  // clip it), so CSS alone can only anchor it to the box, leaving the whole
  // composer height between menu and trigger. Measure the trigger pill on
  // open and pin the menu right above it instead.
  useLayoutEffect(() => {
    if (!composerModelOpen) return;
    const trigger = composerModelTriggerRef.current;
    const popover = composerModelPopoverRef.current;
    const form = popover?.parentElement;
    if (!trigger || !popover || !form) return;
    const triggerRect = trigger.getBoundingClientRect();
    const formRect = form.getBoundingClientRect();
    popover.style.right = `${formRect.right - triggerRect.right}px`;
    popover.style.bottom = `${formRect.bottom - triggerRect.top + 4}px`;
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
      if (!bridge.running) return "skipped";
      let keepLoading = false;
      setHermesSessionsLoading(true);
      try {
        const sessions = applySessionTitleOverrides(await listHermesSessions());
        hermesSessionsHydratedRef.current = true;
        setHermesSessionsHydrated(true);
        const pendingMessages = pendingHermesMessagesRef.current;
        const selectedSessionId = selectedHermesSessionIdRef.current;
        const workingSessions = workingSessionIdsRef.current;
        const waitingSessions = waitingSessionIdsRef.current;
        setHermesSessionItems((current) =>
          mergeActiveHermesSessions(sessions, current, {
            selectedSessionId,
            workingSessionIds: workingSessions,
            waitingSessionIds: waitingSessions,
            pendingMessages,
            defaultModelId: defaultGenerationModelIdRef.current,
          }),
        );
        setSelectedHermesSessionId((current) => {
          if (newSessionModeRef.current) {
            selectedHermesSessionIdRef.current = undefined;
            return undefined;
          }
          if (
            current &&
            (sessions.some((session) => session.id === current) ||
              shouldRetainHermesSessionId(current, {
                selectedSessionId: current,
                workingSessionIds: workingSessions,
                waitingSessionIds: waitingSessions,
                pendingMessages,
              }))
          ) {
            selectedHermesSessionIdRef.current = current;
            return current;
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
    [bridge.running, selectedTask?.hermesSessionId],
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
      const provider = settings.generationProvider || "venice";
      const selectedModelId = generationSelectionId(settings, fallbackModelId);
      localGenerationRef.current = local;
      setLocalGeneration(local);
      generationProviderRef.current = provider;
      setGenerationProvider(provider);
      defaultGenerationModelIdRef.current = selectedModelId;
      setDefaultGenerationModelId(selectedModelId);
      setGenerationCostQuality(settings.costQuality);
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
      const [settingsResponse, modelsResponse] = await Promise.all([
        providerModelSettings(),
        listVeniceModels("generation"),
      ]);
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

  useEffect(() => {
    if (composerModelLocked) setComposerModelOpen(false);
  }, [composerModelLocked]);

  function composerModelSelectionLocked() {
    const sessionId = selectedHermesSessionIdRef.current;
    return Boolean(
      sessionId && !newSessionModeRef.current && !isProvisionalHermesSessionId(sessionId),
    );
  }

  function showComposerModelLockedNotice() {
    setComposerModelOpen(false);
    toast(MODEL_CHANGE_LOCKED_NOTICE, { id: MODEL_SWITCH_TOAST_ID });
  }

  // Stale catalog (the mount fetch can fail while the bridge is starting) is
  // refreshed in the background on every open, like Settings does.
  function openComposerModelPicker() {
    if (composerModelSelectionLocked()) {
      showComposerModelLockedNotice();
      return;
    }
    setModelSearch("");
    setComposerModelFlyout(null);
    setComposerModelOpen(true);
    setSandboxMenuOpen(false);
    void loadGenerationModel();
  }

  // Reflects the global generation selection into composer state directly (not
  // via the backend return value, which tests stub out): the remote flip and
  // the mount fetch already round-trip through commitGenerationSettings.
  function markRemoteGenerationSelected(modelId: string) {
    generationProviderRef.current = "venice";
    setGenerationProvider("venice");
    defaultGenerationModelIdRef.current = modelId;
    setDefaultGenerationModelId(modelId);
  }

  async function selectLocalGeneration() {
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
    try {
      await setLocalGenerationEnabled(true);
      generationProviderRef.current = "local";
      setGenerationProvider("local");
      defaultGenerationModelIdRef.current = selectedModelId;
      setDefaultGenerationModelId(selectedModelId);
      dispatchProviderModelSettingsChanged({
        mode: "generation",
        modelId: selectedModelId,
      });
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
      return false;
    }
    toast(MODEL_SWITCH_DEFAULT_ONLY_NOTICE, { id: MODEL_SWITCH_TOAST_ID });
    return true;
  }

  // Switching the model from the composer is only allowed before a thread
  // exists. It writes the app-wide text-model default (Settings' model rows and
  // this pill refresh through the same changed event), and new sessions inherit
  // that choice at creation time.
  async function handleSelectGenerationModel(modelId: string, costQuality?: number) {
    setComposerModelOpen(false);
    if (composerModelSelectionLocked()) {
      showComposerModelLockedNotice();
      return false;
    }

    // Local is a synthetic catalog option (prefixed id), so it routes through
    // the provider switch rather than a remote model set.
    if (modelId.startsWith(LOCAL_GENERATION_OPTION_ID_PREFIX)) {
      return selectLocalGeneration();
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
    try {
      if (costQuality !== undefined) {
        const next = await setCostQuality(costQuality);
        setGenerationCostQuality(next.costQuality);
      }
      await setVeniceModel("generation", modelId);
      markRemoteGenerationSelected(modelId);
      dispatchProviderModelSettingsChanged({ mode: "generation", modelId });
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
      return false;
    }
    toast(MODEL_SWITCH_DEFAULT_ONLY_NOTICE, { id: MODEL_SWITCH_TOAST_ID });
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
      // Feature 04: a disconnect is NOT a resolution — pending actions must
      // survive it. markDisconnected is intentionally a no-op on state; the
      // reconcile after a successful reconnect (below) is what marks anything
      // unconfirmed as stale rather than dropping it.
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
    if (!bridge.running || !selectedHermesSessionId) return;
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
            continueAfterCompletedTurn(selectedHermesSessionId);
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
  }, [bridge.running, selectedHermesSessionId]);

  useEffect(() => {
    if (!bridge.running || !selectedHermesSessionId) return;
    if (isProvisionalHermesSessionId(selectedHermesSessionId)) return;
    void loadFilesystemSnapshot();
  }, [bridge.running, selectedHermesSessionId, selectedHermesMessages.length]);

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
    sessionContinuity = null;
    void (async () => {
      try {
        const status = await hermesBridgeStatus();
        if (cancelled) return;
        setBridge(status);
      } catch (err) {
        if (!cancelled) setError(describeHermesError(err), reportableAgentErrorOptions(err));
      }
    })();
    return () => {
      cancelled = true;
      // Keep any mid-run session alive for the next mount before the
      // gateways (and with them the live event streams) go away.
      sessionContinuity = captureSessionContinuity({
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
      });
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

  async function handleBuiltinComposerSlashCommand(commandText: string) {
    if (categoryRef.current) return false;
    const parsed = parseBuiltinComposerSlashCommand(commandText);
    if (!parsed) return false;

    if (parsed.name === "model") {
      await runModelSlashCommand(parsed.argument, commandText);
      return true;
    }

    if (parsed.name === "image") {
      if (!IMAGE_GENERATION_ENABLED) {
        setError("Image generation is not available.");
        return true;
      }
      await runImageSlashCommand(parsed.argument, commandText);
      return true;
    }

    if (parsed.name === "video") {
      if (!VIDEO_GENERATION_ENABLED) {
        setError("Video generation is not available.");
        return true;
      }
      await runVideoSlashCommand(parsed.argument, commandText);
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
  ): Promise<ImageSafeModeConsentChoice> {
    return new Promise((resolve) => {
      const request = { variant, resolve };
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
  async function runImageSlashCommand(argument: string, commandText: string) {
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
      pinnedModel = settings.imageModel || undefined;
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
        const choice = await requestImageSafeModeConsent("slash");
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
                  averageExecutionMs: progress.averageExecutionMs,
                  executionMs: progress.executionMs,
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
                  averageExecutionMs: progress.averageExecutionMs,
                  executionMs: progress.executionMs,
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
          averageExecutionMs: progress.averageExecutionMs,
          executionMs: progress.executionMs,
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
          averageExecutionMs: progress.averageExecutionMs,
          executionMs: progress.executionMs,
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
          averageExecutionMs: progress.averageExecutionMs,
          executionMs: progress.executionMs,
        });
        upsertStoredVideoSlashTurn({
          ...turn,
          pending: true,
          averageExecutionMs: progress.averageExecutionMs,
          executionMs: progress.executionMs,
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

  async function runVideoSlashCommand(argument: string, commandText: string) {
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
      pinnedModel = settings.videoModel || undefined;
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
        const choice = await requestImageSafeModeConsent("video-slash");
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

  async function runModelSlashCommand(argument: string, commandText: string) {
    if (composerModelSelectionLocked()) {
      clearComposerCommandDraft(commandText);
      showComposerModelLockedNotice();
      return;
    }
    const query = argument.trim();
    if (!query) {
      clearComposerCommandDraft(commandText);
      openComposerModelPicker();
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

    const selected = await handleSelectGenerationModel(resolution.model.id);
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

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const message = draft.trim();
    if (
      (!message && !attachments.length) ||
      submitting ||
      importingFiles ||
      creditActionsDisabledReason ||
      selectedHermesSessionIsProvisional ||
      imageSlashBlockedByModel
    )
      return;
    if (message && (await handleBuiltinComposerSlashCommand(message))) return;
    const attachmentQueueSessionId =
      attachments.length > 0 &&
      !category &&
      !newSessionModeRef.current &&
      selectedHermesSessionId &&
      workingSessionIdsRef.current.has(selectedHermesSessionId)
        ? selectedHermesSessionId
        : undefined;
    if (attachmentQueueSessionId) {
      let prepared: PreparedComposerSubmission;
      try {
        prepared = await prepareComposerSubmission(message, attachments);
      } catch (err) {
        // The draft and attachments are still in the composer - only the
        // banner is needed for recovery, unlike the full submit path below.
        setError(messageFromError(err));
        return;
      }
      const sizeWarning = oversizedComposerInputWarning({
        content: prepared.runtimeContent,
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
      enqueueAttachmentFollowUp(attachmentQueueSessionId, prepared, attachments);
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
      const steerEntry = { text: message, accepted: false, toolDrained: false };
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
      const runtimeContent = reportCategory
        ? categoryPrompt(reportCategory, prepared.runtimeContent)
        : prepared.runtimeContent;
      const sizeWarning = oversizedComposerInputWarning({
        content: runtimeContent,
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
        onAttachmentsUpdated: (nextAttachments) => {
          submittedAttachments = nextAttachments;
        },
        ...(nextIssueReport ? { issueReport: nextIssueReport } : {}),
      });
      if (reportFollowUpSessionId) {
        deferredFailedIssueReportDeliverySessionIdsRef.current.delete(reportFollowUpSessionId);
      }
      setError(null);
      toast.dismiss(SESSION_BUSY_TOAST_ID);
    } catch (err) {
      // Restore the composer so a failed send doesn't eat the message, its
      // category chip, or its attachments — but only where the user hasn't
      // typed or attached something new during the in-flight send.
      if (clearedDraft && (composerEditorRef.current?.isEmpty() ?? true)) {
        composerEditorRef.current?.setContent(message, reportCategory);
        rememberComposerDraft(submittedDraftKey, message, reportCategory, attachments);
      }
      if (clearedAttachments) {
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
            sessionId: clearedIssueReportReview.sessionId,
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
      if (isSessionBusyError(err)) {
        // A busy rejection is proof the gateway is healthy — retire any stale
        // connection banner along with showing the nudge.
        setError(null);
        toast(SESSION_BUSY_NOTICE, { id: SESSION_BUSY_TOAST_ID });
      } else {
        setError(messageFromError(err));
      }
    } finally {
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
    createdAt,
    displayContent,
    fromSessionId,
    model,
    title,
    toSessionId,
  }: {
    createdAt: string;
    displayContent: string;
    fromSessionId: string;
    model?: string;
    title: string;
    toSessionId: string;
  }) {
    if (fromSessionId === toSessionId) return;
    setHermesSessionItems((current) => {
      const replacement: HermesSessionInfo = {
        id: toSessionId,
        title,
        preview: displayContent,
        started_at: createdAt,
        last_active: createdAt,
        message_count: 1,
        ...(model ? { model } : {}),
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
    runtimeSessionId,
    sessionDisplayTitle,
    storedSessionId,
  }: {
    gateway: HermesGatewayClient;
    runtimeSessionId: string;
    sessionDisplayTitle: string;
    storedSessionId: string;
  }) {
    sessionGatewayUnlistenRef.current.get(storedSessionId)?.();
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
      }
      // Feature 11: roll EVERY classified event into the global activity store
      // that backs the Agent activity drawer. The store is total and ignores
      // unattributable events, so one unconditional call covers all kinds; it
      // derives the session's phase (running/waiting/background/error/complete),
      // current tool, and subagent count from the normalized event — never from
      // the raw frame (raw JSON belongs to feature 15's trace panel).
      hermesActivityStore.record(storedClassified, hermesModeFor(storedSessionId));
      // Feature 14: extract any file/artifact reference this event carries into
      // the per-session artifact timeline behind the drawer's "Artifacts"
      // section. The store is total and only acts on `tool` completions that
      // name a known file/url field (conservative — never parses prose), so one
      // unconditional call is safe for every kind. Mode rides along so each
      // artifact can show its blast radius (sandboxed copy vs unrestricted path).
      hermesArtifactStore.record(storedClassified, hermesModeFor(storedSessionId));
      const nextSessionEvents = [
        ...(liveEventsRef.current[storedSessionId] ?? []),
        classified,
      ].slice(-200);
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
      const status = agentStatusFromHermesEvent(classified);
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
        dispatchAgentSessionStatus({
          sessionId: storedSessionId,
          title: sessionDisplayTitle,
          status,
          summary: agentStatusSummaryFromHermesEvent(classified, status),
          ...activityCounts,
        });
      }
      if (isTerminalHermesEvent(classified)) {
        unlisten();
        if (!activityCounts) {
          clearSessionActivity(storedSessionId);
        }
        if (status === "completed") {
          // Serialize any undrained text steer ahead of the first local
          // attachment follow-up. Each accepted follow-up installs its own
          // terminal listener, which advances the attachment FIFO one turn at
          // a time.
          continueAfterCompletedTurn(storedSessionId);
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
      /** Create + select the session and add the user bubble, then stop BEFORE
       * `prompt.submit` (the `/image` flow): the model is never invoked, and the
       * caller renders the result itself. Returns the stored session id so the
       * caller can attach its own turns. Forces the non-optimistic create path so
       * the selected id is the canonical stored id (optimistic migration doesn't
       * move the selection). */
      skipPrompt?: boolean;
    },
  ): Promise<string | undefined> {
    if (creditActionsDisabledReason && !options?.skipPrompt) {
      throw new Error(creditActionsDisabledReason);
    }
    const displayContent = options?.displayContent ?? content;
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
    const targetSessionId = explicitSession?.id
      ? explicitSession.id
      : newSessionModeRef.current
        ? undefined
        : selectedHermesSessionId;
    // hermesModelIdFor: when local generation is active the default (and any
    // session row backfilled from it) carries the synthetic local option id,
    // which must never reach Hermes — session.create/ensure get the raw id.
    const selectedSessionModelId = targetSessionId
      ? hermesSessionItemsRef.current
          .find((session) => session.id === targetSessionId)
          ?.model?.trim()
      : undefined;
    const existingSessionModelId = explicitSession?.model?.trim() || selectedSessionModelId;
    const targetSessionModelId = hermesModelIdFor(
      targetSessionId
        ? existingSessionModelId || defaultGenerationModelIdRef.current
        : defaultGenerationModelIdRef.current,
    );
    // JUN-171 (Phase A): fold any held fast-path `/image` outputs for this
    // session into the turn so they ride the same structured-attach path as
    // composer images and enter the model's context. Never on the skipPrompt
    // (`/image`) path itself — that would flush a prior image with no following
    // prompt (the semantics ADR 0003 decision 2 deliberately avoids).
    const heldFastPathImages =
      options?.skipPrompt || !targetSessionId
        ? []
        : uniqueAttachmentsByWorkspacePath([
            ...(pendingFastPathImagesRef.current[targetSessionId] ?? []),
            ...storedPendingImageSlashAttachments(targetSessionId),
          ]);
    // The video counterpart of the fold above, gated the same way (never on
    // the skipPrompt fast path itself, only on a real follow-up prompt).
    const heldVideoContexts =
      options?.skipPrompt || !targetSessionId
        ? []
        : storedPendingVideoSlashContexts(targetSessionId);
    const turnAttachments = [...(options?.attachments ?? []), ...heldFastPathImages];
    const pendingImages = pendingImageAttachments(
      turnAttachments.map((attachment) => attachment.attach),
    );
    // Resolve strictly from the catalog: selectedModelOption synthesizes a
    // zero-capability stub for an unknown id, which would read as non-vision and
    // wrongly downgrade a vision-capable (but stale/not-yet-loaded) model. find
    // returns undefined when unresolved so the guard below skips the fallback.
    const targetGenerationModel = targetSessionModelId
      ? generationModelsRef.current.find((model) => model.id === targetSessionModelId)
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
            modelName: targetGenerationModel?.name ?? targetSessionModelId,
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
      targetSessionId || options?.issueReport
        ? undefined
        : attachmentOnlyTitle
          ? Promise.resolve(attachmentOnlyTitle)
          : agentSessionTitleForPrompt(titleContent).then((suggestion) => suggestion.title);
    const listedTargetSession = targetSessionId
      ? hermesSessionItemsRef.current.find((session) => session.id === targetSessionId)
      : undefined;
    const fallbackSessionTitle = targetSessionId
      ? explicitSession?.title?.trim() ||
        explicitSession?.preview?.trim() ||
        listedTargetSession?.title?.trim() ||
        listedTargetSession?.preview?.trim() ||
        titleFromPrompt(titleContent)
      : options?.issueReport
        ? "Issue report"
        : attachmentOnlyTitle || titleFromPrompt(titleContent);
    const optimisticSession =
      targetSessionId || options?.skipPrompt
        ? undefined
        : startOptimisticHermesSession({
            displayContent,
            title: fallbackSessionTitle,
            ...(targetSessionModelId ? { model: targetSessionModelId } : {}),
          });
    let storedSessionIdForRollback: string | undefined;
    const rollbackOptimisticBeforePrompt = (err: unknown): never => {
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
    const { created, gateway, sessionTitle, storedSessionId } = await (async () => {
      const [nextGateway, nextSessionTitle] = await Promise.all([
        ensureHermesGateway(
          targetSessionId ? sessionUnrestricted(targetSessionId) : fullModeDraftRef.current,
        ),
        titlePromise ?? Promise.resolve(undefined),
      ]);
      const nextCreated = targetSessionId
        ? undefined
        : await nextGateway.request<HermesRuntimeSessionResponse>("session.create", {
            title: nextSessionTitle ?? fallbackSessionTitle,
            cols: 96,
            ...(targetSessionModelId ? { model: targetSessionModelId } : {}),
          });
      const nextStoredSessionId =
        targetSessionId ?? nextCreated?.stored_session_id ?? nextCreated?.session_id;
      if (!nextStoredSessionId) {
        throw new Error("Hermes did not create a session.");
      }
      return {
        created: nextCreated,
        gateway: nextGateway,
        sessionTitle: nextSessionTitle,
        storedSessionId: nextStoredSessionId,
      };
    })().catch(rollbackOptimisticBeforePrompt);
    storedSessionIdForRollback = storedSessionId;
    const queuedIssueReport = options?.issueReport;
    if (queuedIssueReport && targetSessionId) {
      queuedIssueReport.diagnosisStartedAt = new Date().toISOString();
    }
    const clearQueuedIssueReport = () => {
      if (
        queuedIssueReport &&
        pendingIssueReportsRef.current.get(storedSessionId) === queuedIssueReport
      ) {
        pendingIssueReportsRef.current.delete(storedSessionId);
      }
    };
    if (options?.issueReport) {
      pendingIssueReportsRef.current.set(storedSessionId, options.issueReport);
    }
    if (!targetSessionId) {
      rememberSessionMode(storedSessionId, fullModeDraftRef.current);
    }
    const sessionDisplayTitle = sessionTitle || fallbackSessionTitle;
    const ensureStoredHermesSession = () =>
      ensureHermesBridgeSession({
        sessionId: storedSessionId,
        ...(!targetSessionId ? { title: sessionDisplayTitle } : {}),
        ...(targetSessionModelId ? { model: targetSessionModelId } : {}),
      });
    if (optimisticSession) {
      await ensureStoredHermesSession().catch(rollbackOptimisticBeforePrompt);
      migrateOptimisticHermesSession({
        createdAt: optimisticSession.createdAt,
        displayContent,
        fromSessionId: optimisticSession.id,
        ...(targetSessionModelId ? { model: targetSessionModelId } : {}),
        title: sessionDisplayTitle,
        toSessionId: storedSessionId,
      });
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
    let runtimeSessionId: string | undefined;
    try {
      runtimeSessionId =
        created?.session_id ??
        runtimeSessionIdsRef.current[storedSessionId] ??
        (
          await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
            session_id: storedSessionId,
            cols: 96,
          })
        ).session_id;
    } catch (err) {
      clearQueuedIssueReport();
      if (optimisticSession) {
        removeOptimisticHermesSession(optimisticSession.id, storedSessionIdForRollback);
      }
      throw err;
    }
    if (!runtimeSessionId) {
      clearQueuedIssueReport();
      rollbackOptimisticBeforePrompt(new Error("Hermes did not resume the session."));
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
          runtimeSessionId,
          storedSessionId,
          turnAttachments,
        );
        options?.onAttachmentsUpdated?.(updatedAttachments);
      } catch (err) {
        clearQueuedIssueReport();
        rollbackOptimisticBeforePrompt(err);
      }
    }
    const createdAt = optimisticSession?.createdAt ?? new Date().toISOString();
    setRuntimeSessionIds((current) => ({
      ...current,
      [storedSessionId]: runtimeSessionId,
    }));
    if (!optimisticSession) {
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
        ...(targetSessionModelId ? { model: targetSessionModelId } : {}),
      };
      setHermesSessionItems((current) => {
        const existingSession = current.find((session) => session.id === storedSessionId);
        if (existingSession) {
          const mergedSession: HermesSessionInfo = targetSessionId
            ? {
                ...existingSession,
                title: existingSession.title?.trim() ? existingSession.title : sessionDisplayTitle,
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
    attachHermesSessionEventListener({
      gateway,
      runtimeSessionId,
      sessionDisplayTitle,
      storedSessionId,
    });
    try {
      // Feature 15: record the outbound prompt.submit in the trace buffer. Its
      // params are sanitized before storage (the text is the user's own prompt,
      // kept; any secret-like value would be masked). This is the primary
      // outbound call from this surface; other RPCs go direct via
      // gateway.request and are not yet traced (see feature 15 notes).
      hermesTraceBuffer.recordOutbound({
        sessionId: storedSessionId,
        method: "prompt.submit",
        params: { session_id: runtimeSessionId, text: promptSubmitContent },
      });
      await gateway.request("prompt.submit", {
        session_id: runtimeSessionId,
        text: promptSubmitContent,
      });
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
        heldVideoContexts.map((turn) => turn.id),
      );
      await loadHermesSessions({
        suppressStartupRequestError: !hermesSessionsHydratedRef.current,
      });
    } catch (err) {
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
      // persisted message and reads as a send the agent ignored.
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
      if (isSessionBusyError(err)) {
        // The gateway rejected this prompt because the previous turn is still
        // running — the session itself is healthy, so keep the listener and
        // working state. Callers translate this into the composer notice.
        throw err;
      }
      sessionGatewayUnlistenRef.current.get(storedSessionId)?.();
      recordSessionErrorActivity(storedSessionId, messageFromError(err));
      dispatchAgentSessionStatus({
        sessionId: storedSessionId,
        title: sessionDisplayTitle,
        status: "failed",
        summary: messageFromError(err),
      });
      throw err;
    }
  }

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
      return parseCompressSessionResult(sessionId, raw);
    },
    // Same stable-closure rationale as fetchSessionUsage above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
    // Feature 04: the gateway is back. Any pending action not re-announced by a
    // fresh event is now unverifiable across the drop, so mark it stale —
    // visible but visually distinct — rather than silently dropping a possible
    // blocker. A re-announced request flips its row back to open in the feed.
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
          dispatchAgentSessionStatus({
            sessionId,
            title:
              hermesSessionItems.find((session) => session.id === sessionId)?.title ??
              "Agent session",
            status: "completed",
            summary: "June finished.",
            ...activityCounts,
          });
          continueAfterCompletedTurn(sessionId);
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
    setApprovalSubmitting((current) => ({ ...current, [requestId]: choice }));
    try {
      // The approval lives in the runtime process that asked, so the
      // response must go out on that mode's gateway.
      const gateway = await ensureHermesGateway(unrestricted);
      await gateway.request("approval.respond", {
        session_id: sessionId,
        choice,
      });
      pushLiveEvent(
        liveEventKey,
        classifyOptimisticLiveEvent({
          type: "approval.response",
          session_id: sessionId,
          payload: { request_id: requestId, choice },
        }),
      );
      // Feature 04: the user just answered this approval — clear its global
      // "Needs you" row immediately (the response itself is the resolution).
      pendingActionStore.resolveRequest(liveEventKey, requestId);
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
        pendingActionStore.resolveRequest(liveEventKey, requestId);
        void loadHermesSessions();
        setError(SESSION_GONE_MESSAGE, { sessionId });
      } else {
        setError(message, { sessionId });
      }
    } finally {
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
      pushLiveEvent(
        liveEventKey,
        classifyOptimisticLiveEvent({
          type: "clarify.response",
          payload: { request_id: requestId, answer },
        }),
      );
      // Feature 04: the user answered the clarification — clear its pending record.
      pendingActionStore.resolveRequest(liveEventKey, requestId);
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
      pushLiveEvent(
        liveEventKey,
        classifyOptimisticLiveEvent({
          type: "sudo.response",
          session_id: sessionId,
          payload: { request_id: requestId, granted: approved, mode },
        }),
      );
      // Feature 04: the user resolved the sudo prompt — clear its pending record.
      pendingActionStore.resolveRequest(liveEventKey, requestId);
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
      pushLiveEvent(
        liveEventKey,
        classifyOptimisticLiveEvent({
          type: "secret.response",
          session_id: sessionId,
          payload: { request_id: requestId, provided: true },
        }),
      );
      // Feature 04: the user provided the secret — clear its pending record.
      pendingActionStore.resolveRequest(liveEventKey, requestId);
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
    setCliAccessSubmitting(true);
    try {
      await setHermesAgentCliAccess(true);
      setCliAccessEnabled(true);
      await submitHermesSession(AGENT_CLI_ACCESS_ENABLED_MESSAGE);
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCliAccessSubmitting(false);
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
    const nextEvents = [...(liveEventsRef.current[key] ?? []), event].slice(-200);
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
    sessionId: string,
    update: (items: QueuedAttachmentFollowUp[]) => QueuedAttachmentFollowUp[],
  ) {
    const nextItems = update(queuedAttachmentFollowUpsRef.current[sessionId] ?? []);
    const next = { ...queuedAttachmentFollowUpsRef.current };
    if (nextItems.length) {
      next[sessionId] = nextItems;
    } else {
      delete next[sessionId];
    }
    writeQueuedAttachmentFollowUps(next);
  }

  function enqueueAttachmentFollowUp(
    sessionId: string,
    prepared: PreparedComposerSubmission,
    queuedAttachments: AgentAttachment[],
  ) {
    queuedAttachmentFollowUpSeqRef.current += 1;
    const item: QueuedAttachmentFollowUp = {
      id: `attachment-follow-up-${queuedAttachmentFollowUpSeqRef.current}`,
      prepared,
      attachments: queuedAttachments,
      status: "queued",
    };
    updateQueuedAttachmentFollowUps(sessionId, (items) => [...items, item]);
  }

  function removeQueuedAttachmentFollowUp(sessionId: string, itemId: string) {
    updateQueuedAttachmentFollowUps(sessionId, (items) =>
      items.filter((item) => item.id !== itemId || item.status === "sending"),
    );
  }

  function editQueuedAttachmentFollowUp(sessionId: string, itemId: string) {
    if (sessionId !== selectedHermesSessionIdRef.current) return;
    if (draftRef.current.trim() || attachmentsRef.current.length) return;
    const item = queuedAttachmentFollowUpsRef.current[sessionId]?.find(
      (candidate) => candidate.id === itemId,
    );
    if (!item || item.status === "sending") return;
    removeQueuedAttachmentFollowUp(sessionId, itemId);
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
    sessionId: string,
    itemId?: string,
    options: { afterCompletion?: boolean } = {},
  ) {
    if (!options.afterCompletion && workingSessionIdsRef.current.has(sessionId)) return false;
    const queued = queuedAttachmentFollowUpsRef.current[sessionId] ?? [];
    const item = itemId ? queued.find((candidate) => candidate.id === itemId) : queued[0];
    if (!item || item.status === "sending") return false;
    // Automatic advancement (no itemId) stops at a failed head rather than
    // resending it: the row's UI is an explicit Retry, and silently resending
    // a message the user watched fail - possibly with an image already
    // attached - is worse than holding the queue until they decide.
    if (!itemId && item.status === "failed") return false;
    const session = hermesSessionItemsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session) {
      updateQueuedAttachmentFollowUps(sessionId, (items) =>
        items.map((candidate) =>
          candidate.id === item.id
            ? { ...candidate, status: "failed", error: "This session is no longer available." }
            : candidate,
        ),
      );
      return false;
    }
    updateQueuedAttachmentFollowUps(sessionId, (items) =>
      items.map((candidate) =>
        candidate.id === item.id
          ? { ...candidate, status: "sending", error: undefined }
          : candidate,
      ),
    );
    try {
      await submitHermesSession(item.prepared.runtimeContent, session, {
        displayContent: item.prepared.displayContent,
        titleContent: item.prepared.titleContent,
        attachments: item.attachments,
        selectSession: false,
        onAttachmentsUpdated: (nextAttachments) => {
          updateQueuedAttachmentFollowUps(sessionId, (items) =>
            items.map((candidate) =>
              candidate.id === item.id ? { ...candidate, attachments: nextAttachments } : candidate,
            ),
          );
        },
      });
      updateQueuedAttachmentFollowUps(sessionId, (items) =>
        items.filter((candidate) => candidate.id !== item.id),
      );
      return true;
    } catch (err) {
      const failedAttachments = err instanceof AttachBlockedError ? err.attachments : undefined;
      updateQueuedAttachmentFollowUps(sessionId, (items) =>
        items.map((candidate) =>
          candidate.id === item.id
            ? {
                ...candidate,
                ...(failedAttachments ? { attachments: failedAttachments } : {}),
                status: "failed",
                error: messageFromError(err),
              }
            : candidate,
        ),
      );
      return false;
    }
  }

  function continueAfterCompletedTurn(sessionId: string) {
    if (continuingCompletedTurnSessionIdsRef.current.has(sessionId)) return;
    continuingCompletedTurnSessionIdsRef.current.add(sessionId);
    const unconsumedSteers = pendingSteerBySessionIdRef.current[sessionId]?.filter(
      (entry) => !(entry.accepted && entry.toolDrained),
    );
    clearSubmittedSteers(sessionId);
    window.setTimeout(async () => {
      if (unconsumedSteers?.length) {
        const followUpSession = hermesSessionItemsRef.current.find(
          (session) => session.id === sessionId,
        );
        if (!followUpSession) {
          continuingCompletedTurnSessionIdsRef.current.delete(sessionId);
          return;
        }
        const followUpText = unconsumedSteers.map((entry) => entry.text).join("\n");
        try {
          await submitHermesSession(followUpText, followUpSession, { selectSession: false });
        } catch (err) {
          setError(messageFromError(err), { sessionId });
        } finally {
          continuingCompletedTurnSessionIdsRef.current.delete(sessionId);
        }
        return;
      }
      try {
        await deliverQueuedAttachmentFollowUp(sessionId, undefined, { afterCompletion: true });
      } finally {
        continuingCompletedTurnSessionIdsRef.current.delete(sessionId);
      }
    }, 0);
  }

  function clearSubmittedSteers(sessionId: string) {
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
    sessionId: string,
    item: QueuedAttachmentFollowUp,
    options: { demo?: boolean } = {},
  ) {
    const sessionWorking = options.demo || workingSessionIds.has(sessionId);
    const firstInQueue = queuedAttachmentFollowUpsRef.current[sessionId]?.[0]?.id === item.id;
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
                onClick={() => void deliverQueuedAttachmentFollowUp(sessionId, item.id)}
              >
                <IconArrowRotateClockwise size={14} />
              </button>
            ) : !sessionWorking && firstInQueue ? (
              <button
                type="button"
                aria-label="Send queued message"
                title="Send now"
                onClick={() => void deliverQueuedAttachmentFollowUp(sessionId, item.id)}
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
                        [sessionId]: (current[sessionId] ?? []).filter(
                          (followUp) => followUp.id !== item.id,
                        ),
                      }));
                      draftRef.current = item.prepared.typedMessage;
                      setDraft(item.prepared.typedMessage);
                      composerEditorRef.current?.setContent(item.prepared.typedMessage);
                      return;
                    }
                    editQueuedAttachmentFollowUp(sessionId, item.id);
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
                          [sessionId]: (current[sessionId] ?? []).filter(
                            (followUp) => followUp.id !== item.id,
                          ),
                        }))
                      : removeQueuedAttachmentFollowUp(sessionId, item.id)
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
    try {
      await submitHermesSession(initialPrompt);
      composerEditorRef.current?.clear();
      forgetComposerDraft(NEW_SESSION_DRAFT_KEY);
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
    scrubHermesSessionState(sessionId);
    pendingIssueReportsRef.current.delete(sessionId);
    setReviewableIssueReport(sessionId, null);
    updateQueuedAttachmentFollowUps(sessionId, () => []);
    forgetComposerDraft(sessionComposerDraftKey(sessionId));
    // Every deletion funnels through here (the in-workspace delete and the
    // sidebar/sessions-list AGENT_DELETE_SESSION_EVENT), so this is the one
    // place that drops the session's Unrestricted record — a stale entry
    // would hand full write access to any future session that recycled the
    // id.
    forgetSessionMode(sessionId);
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
      settledTitleKind === "manual" ||
      settledTitleKind === "exchange"
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
    const firstAssistantReply =
      firstUserMessageIndex >= 0
        ? messages
            .slice(firstUserMessageIndex + 1)
            .find(
              (message) => message.role === "assistant" && visibleHermesMessageText(message).trim(),
            )
        : undefined;
    const reply = truncateAgentTitleResponseExcerpt(
      visibleHermesMessageText(firstAssistantReply).trim(),
    );
    const hasReply = Boolean(reply);
    if (source === "prompt") {
      if (!hasReply) return;
    } else if (sessionTitleOverridesRef.current[sessionId]) {
      return;
    } else {
      const session = hermesSessionItems.find((item) => item.id === sessionId);
      if (!session || !isReplaceableAgentSessionTitle(session.title)) return;
    }
    titleSuggestionInFlightSessionIdsRef.current.add(sessionId);
    let shouldRecheckLatestMessages = false;
    try {
      const suggestion = await agentSessionTitleForPrompt(prompt, hasReply ? reply : undefined);
      if (titleSuggestionSessionIdsRef.current.has(sessionId)) return;
      if (!suggestion.fromModel && sessionTitleOverridesRef.current[sessionId]) {
        return;
      }
      const title = suggestion.title;
      const nextSource: AgentSessionTitleSource =
        suggestion.fromModel && hasReply ? "exchange" : "prompt";
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
    return () => {
      delete w.__steerSubmitDemo;
      delete w.__upNextDemo;
    };
  }, [selectedHermesSessionId, selectedHermesSessionIsProvisional]);

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
  const surfacedArtifacts = [...turnArtifacts.values()].flat().concat(devArtifacts);
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
  }, [renderedTurnsSignature, selectedHermesSessionId, selectedHistoryLoaded, selectedTaskId]);

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
        {fundingNotice ??
          (creditActionsDisabledReason ? (
            <p className="agent-composer-notice" role="status">
              {creditActionsDisabledReason}
            </p>
          ) : null)}
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
        {selectedHermesSessionId && selectedFollowUpCount ? (
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
                    renderQueuedAttachmentFollowUp(selectedHermesSessionId, item),
                  )}
                  {selectedUpNextDemoFollowUps.map((item) =>
                    renderQueuedAttachmentFollowUp(selectedHermesSessionId, item, { demo: true }),
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
              {preferredVisionModel && !composerModelLocked ? (
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
                      // suggested pick. This only appears before a thread
                      // exists, where model changes still update the default.
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
                {visibleComposerSizeWarning.switchModel && !composerModelLocked ? (
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
                    ? autoPillDesignation(generationCostQuality)
                    : undefined
                }
                readOnly={composerModelLocked}
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
                    Boolean(creditActionsDisabledReason) ||
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
        {composerModelOpen && !composerModelLocked ? (
          <ModelPickerPopover
            mode="generation"
            flyout={composerModelFlyout}
            model={generationModel}
            options={modelOptions(generationModelOptions, generationModel?.id ?? "")}
            costQuality={generationCostQuality}
            search={modelSearch}
            popoverRef={composerModelPopoverRef}
            searchRef={composerModelSearchRef}
            onFlyoutChange={setComposerModelFlyout}
            onSearchChange={setModelSearch}
            onSelect={(modelId, costQuality) =>
              void handleSelectGenerationModel(modelId, costQuality)
            }
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
        />
      ))}
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
            thinkingOpen={thinkingOpen}
            onThinkingOpenChange={setThinkingOpen}
            onDownloadArtifact={downloadArtifact}
            onOpenArtifact={openArtifact}
            creditActionsDisabledReason={creditActionsDisabledReason}
            onTopUp={handleTopUp}
            topUpLabel={topUpLabel}
            fundingTier={fundingTier}
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
          onRename={
            !newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional
              ? (title) => renameHermesSession(selectedHermesSessionId, title)
              : undefined
          }
          inProject={sessionInProject}
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
          <div ref={agentScrollRef} className="agent-scroll">
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
  artifactCount = 0,
  artifactsOpen = false,
  inProject = false,
  onToggleArtifacts,
  onRename,
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
  artifactCount?: number;
  artifactsOpen?: boolean;
  inProject?: boolean;
  onToggleArtifacts?: () => void;
  onRename?: (title: string) => void;
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
    onRename || onMoveToProject || onDelete || onShowUsage || onCompactContext || onOpenTuiDebug,
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
                <span className="detail-breadcrumb-current">{title || "Untitled session"}</span>
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
                {(onRename || onMoveToProject) && (onShowUsage || onCompactContext) ? (
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
    return title
      ? { title, fromModel: true }
      : { title: titleFromPrompt(prompt), fromModel: false };
  } catch {
    return { title: titleFromPrompt(prompt), fromModel: false };
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
              clarifySubmitting={{}}
              sudoSubmitting={{}}
              secretSubmitting={{}}
              thinkingOpen={(key) => thinkingOpenByKey[key] ?? false}
              onApproval={galleryNoop}
              onClarify={galleryNoop}
              onSudo={galleryNoop}
              onSecret={galleryNoop}
              onDownloadArtifact={galleryNoop}
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
  artifacts,
  clarifySubmitting,
  sudoSubmitting,
  secretSubmitting,
  cliAccess,
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
  creditActionsDisabledReason,
  onThinkingOpenChange,
  onTopUp,
  topUpLabel,
  fundingTier,
  onBranch,
  branchingMessageId,
  turn,
}: {
  activeThinkingKey?: string;
  approvalSubmitting: Partial<Record<string, AgentApprovalChoice>>;
  artifacts?: AgentArtifact[];
  clarifySubmitting: Record<string, string>;
  sudoSubmitting: Record<string, "approve" | "deny">;
  secretSubmitting: Record<string, true>;
  /** State + handler for June's in-chat Agent CLI access request card.
   * Optional so the dev gallery can render rows without the live setting. */
  cliAccess?: AgentCliAccessCardProps;
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
  creditActionsDisabledReason?: string;
  onThinkingOpenChange: (key: string, open: boolean) => void;
  onTopUp?: () => void;
  topUpLabel?: string;
  fundingTier?: FundingTier;
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
  // The disclosure owns internal reasoning only. Tool/action rows stay visible
  // outside it so users can see what June is doing without expanding Thought.
  const thinkingRunning = reasoningParts.some((part) => part.status === "running");
  const completedThinkingKey = `turn:${turn.id}:thinking`;
  const thinkingKey =
    thinkingRunning && activeThinkingKey ? activeThinkingKey : completedThinkingKey;
  const wasThinkingRunningRef = useRef(thinkingRunning);
  const carriedOpen =
    !thinkingRunning &&
    wasThinkingRunningRef.current &&
    activeThinkingKey !== undefined &&
    thinkingOpen(activeThinkingKey);
  const thinkingIsOpen = thinkingOpen(thinkingKey) || carriedOpen;
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
  const nonTextParts = turn.parts.filter((part) => part.type !== "text");
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
      }, 1400);
    } catch {
      // Clipboard can fail in restricted contexts; leave the transcript alone.
    }
  }

  // Per-turn transcript actions. Branch is rendered only on Hermes-session rows
  // (which pass `onBranch`); pending user prompts and live assistant rows route
  // to the nearest saved fork point, while other synthetic rows still explain
  // that they need to be saved first.
  const branchSessionId = branchSourceSessionIdForTurn(turn);
  const branchMessageId = turn.branchMessageId ?? turn.id;
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
      className="agent-turn-action-tip"
    >
      <button
        type="button"
        className="agent-turn-action"
        aria-label={copied ? "Copied message" : "Copy message"}
        data-copied={copied ? "true" : undefined}
        onClick={() => void copyTurn()}
      >
        {copied ? (
          // Medium checkmark: the small variant reads too slight as the only
          // confirmation left now that the label is gone.
          <IconCheckmark2Medium size={14} aria-hidden />
        ) : (
          <IconClipboard size={14} aria-hidden />
        )}
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
          {textParts.map((part, index) => (
            <MarkdownContent
              key={`${turn.id}:text:${index}`}
              // Issue-report sessions open with the wrapped investigation
              // prompt; the transcript shows only what the user typed.
              markdown={displayedComposerUserMessageText(part.text)}
            />
          ))}
        </div>
        {turnActions}
      </article>
    );
  }

  return (
    <article className="agent-assistant-turn" data-status={turn.status}>
      <div className="agent-assistant-turn-body">
        {reasoningParts.length > 0 ? (
          <AgentThinkingGroup
            reasoning={reasoningParts}
            running={thinkingRunning}
            open={thinkingIsOpen}
            onOpenChange={(open) => onThinkingOpenChange(thinkingKey, open)}
          />
        ) : null}
        {toolParts.length > 0 ? (
          <div className="agent-tool-stack">
            {toolParts.map((tool) => (
              <AgentToolPartRow key={`tool:${tool.id}`} part={tool} />
            ))}
          </div>
        ) : null}
        {turn.parts.map((part, index) =>
          part.type === "text" ? (
            hasAgentCliAccessRequest(part.text) ? (
              // June's soul emits a literal token to request the Agent CLI
              // access setting; the token renders as an approval card, never
              // as text.
              <div key={`${turn.id}:text:${index}`}>
                {stripAgentCliAccessRequest(part.text) ? (
                  <MarkdownContent markdown={stripAgentCliAccessRequest(part.text)} repairProse />
                ) : null}
                <AgentCliAccessCard cliAccess={cliAccess} />
              </div>
            ) : (
              <div key={`${turn.id}:text:${index}`}>
                <MarkdownContent markdown={part.text} repairProse />
              </div>
            )
          ) : part.type === "context" ? (
            <ContextCompactionPart key={`${turn.id}:context:${index}`} part={part} />
          ) : part.type === "approval" ? (
            <ApprovalPart
              key={`${turn.id}:approval:${part.id}`}
              part={part}
              submitting={approvalSubmitting[part.id]}
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

function copyableTextForTurn(turn: AgentChatTurn): string {
  if (turn.role === "user") return userPromptTextForTurn(turn);
  if (turn.role !== "assistant") return "";
  return turn.parts
    .filter((part): part is Extract<AgentChatPart, { type: "text" }> => part.type === "text")
    .map((part) => stripAgentCliAccessRequest(part.text).trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
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

// The `/image` result, inline in the assistant turn. Running -> shimmer loader;
// complete -> the image (click to enlarge in the file viewer) with a download
// action; error -> the failure message. The bytes ride in `part.dataUrl` for an
// instant thumbnail; open/download key off the imported workspace path.
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

  if (part.status === "running") {
    return (
      <div className="agent-generated-image" data-status="running" role="status" aria-live="polite">
        <div className="agent-generated-image-placeholder">
          <span className="text-shimmer shimmer">Generating image…</span>
        </div>
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
  const imageSrc = part.dataUrl ?? pathPreviewDataUrl;
  const image = imageSrc ? (
    <img src={imageSrc} alt={part.prompt} draggable={false} />
  ) : part.path ? (
    <span className="agent-generated-image-loading text-shimmer shimmer">Loading image...</span>
  ) : null;
  return (
    <figure className="agent-generated-image" data-status="complete">
      {part.path ? (
        <button
          type="button"
          className="agent-generated-image-frame"
          onClick={() => onOpen?.(part)}
          aria-label={`Open ${label}`}
          title="Open image"
        >
          {image}
        </button>
      ) : (
        <div className="agent-generated-image-frame">{image}</div>
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
            <IconArrowInbox size={14} aria-hidden />
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
  if (part.status === "running") {
    const progress = videoProgressLabel(part);
    return (
      <div className="agent-generated-video" data-status="running" role="status" aria-live="polite">
        <div className="agent-generated-video-placeholder">
          <span className="text-shimmer shimmer">Generating video, this can take a minute</span>
          {progress ? <span className="agent-generated-video-progress">{progress}</span> : null}
        </div>
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
  const src = part.path ? localVideoFileSrc(part.path) : undefined;
  return (
    <figure className="agent-generated-video" data-status="complete">
      <div className="agent-generated-video-frame">
        {src ? (
          <video controls src={src} poster={part.posterDataUrl} preload="metadata" />
        ) : (
          <span className="agent-generated-image-loading text-shimmer shimmer">
            Loading video...
          </span>
        )}
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
            <IconArrowInbox size={14} aria-hidden />
            <span>Download</span>
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

function videoProgressLabel(part: Extract<AgentChatPart, { type: "video" }>) {
  if (typeof part.executionMs !== "number" || part.executionMs <= 0) return undefined;
  const elapsed = Math.max(1, Math.round(part.executionMs / 1000));
  if (typeof part.averageExecutionMs !== "number" || part.averageExecutionMs <= 0) {
    return `${elapsed}s elapsed`;
  }
  const total = Math.max(elapsed, Math.round(part.averageExecutionMs / 1000));
  return `${elapsed}s of about ${total}s`;
}

/** A resolved action card renders as a quiet, expandable one-line row instead
 * of a full card — a receipt in the transcript rather than a prompt. The row
 * mirrors {@link ContextCompactionPart}: an outcome glyph (checkmark / cross)
 * that cross-fades to a plain-text "+"/"−" on hover (pure opacity — no layout
 * shift, a WKWebView compositing constraint), a short outcome label, and a
 * truncated one-line detail. Expanding reveals the full detail body (the
 * `children`) minus the action buttons. */
function ResolvedActionRow({
  denied = false,
  label,
  detail,
  children,
}: {
  /** Renders the cross glyph and destructive tint instead of the checkmark. */
  denied?: boolean;
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
      data-choice={denied ? "deny" : "done"}
    >
      <summary>
        <span className="agent-tool-icon">
          {denied ? (
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
      {submitting ? (
        <DotSpinner className="agent-turn-action-spinner" />
      ) : (
        <IconBranchSimple size={14} aria-hidden />
      )}
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
                onChange={(event) => setQuery(event.currentTarget.value)}
                onBlur={() => {
                  if (!query.trim()) setFilterOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  // Esc walks back one step at a time — clear the query,
                  // collapse the filter — before a final Esc (bubbling to
                  // the workspace listener) closes the panel.
                  event.stopPropagation();
                  if (query) setQuery("");
                  else setFilterOpen(false);
                }}
              />
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
              <MarkdownContent markdown={preview.text} highlight={docHighlight} />
            ) : preview.kind === "text" ? (
              <pre className="agent-artifact-source">
                {docHighlight ? highlightText(preview.text, docHighlight, "source") : preview.text}
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
// copies of the same file don't produce twin cards.
function assignArtifactsToTurns(
  turns: AgentChatTurn[],
  artifacts: AgentArtifact[],
): Map<string, AgentArtifact[]> {
  const byTurn = new Map<string, AgentArtifact[]>();
  if (!artifacts.length) return byTurn;
  const claimedPaths = new Set<string>();
  const claimedNames = new Set<string>();
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
  return pending.filter((pendingMessage) => {
    const pendingAt = hermesMessageTimestampMs(pendingMessage);
    return !persisted.some((message) => {
      if (message.role !== pendingMessage.role) return false;
      if (
        !sameVisibleMessageText(
          visibleHermesMessageText(message),
          visibleHermesMessageText(pendingMessage),
        )
      ) {
        return false;
      }
      if (pendingAt === undefined) return true;
      // Only a message persisted at/after the pending send can be its stored
      // copy — an older identical message (e.g. a re-sent "continue") must
      // not swallow the new pending entry and fake a completed turn.
      const persistedAt = hermesMessageTimestampMs(message);
      return persistedAt === undefined || persistedAt >= pendingAt - PENDING_MATCH_SKEW_MS;
    });
  });
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
  let latestAssistantIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") {
      latestUserIndex = index;
    } else if (message.role === "assistant") {
      latestAssistantIndex = index;
    }
  });
  if (latestAssistantIndex < 0) return false;
  if (latestUserIndex < 0) return true;
  return latestAssistantIndex > latestUserIndex;
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

function sessionHasActiveWork(
  sessionId: string,
  workingSessionIds: Set<string>,
  waitingSessionIds: Set<string>,
  liveEvents: Record<string, JuneHermesEvent[]>,
) {
  return (
    workingSessionIds.has(sessionId) ||
    waitingSessionIds.has(sessionId) ||
    (liveEvents[sessionId]?.length ?? 0) > 0
  );
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
    if (record.phase === "running" || record.phase === "background") {
      workingSessionIds.add(record.sessionId);
    } else if (record.phase === "waiting") {
      waitingSessionIds.add(record.sessionId);
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

function agentStatusFromHermesEvent(event: JuneHermesEvent): AgentSessionStatusKind | undefined {
  if (event.kind === "error") return "failed";
  if (event.kind === "pending_action") return "waitingForUser";
  if (event.kind === "pending_action_resolution") return "running";
  if (isTerminalHermesEvent(event)) return "completed";
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
  const withoutWarnings = value.replace(/\n*--- Context Warnings ---[\s\S]*$/m, "");
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
      <span>{action}</span>
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
