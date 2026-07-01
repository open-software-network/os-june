import { listen } from "@tauri-apps/api/event";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowsRepeat } from "central-icons/IconArrowsRepeat";
import { IconBolt } from "central-icons/IconBolt";
import { IconBranchSimple } from "central-icons/IconBranchSimple";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconBubbleWide } from "central-icons/IconBubbleWide";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconExclamationTriangle } from "central-icons/IconExclamationTriangle";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconFolders } from "central-icons/IconFolders";
import { IconConsole } from "central-icons/IconConsole";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconStopCircle } from "central-icons/IconStopCircle";
import { IconToolbox } from "central-icons/IconToolbox";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";
import { IconAnonymous } from "central-icons/IconAnonymous";
import { IconArrowCornerDownRight } from "central-icons/IconArrowCornerDownRight";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconConsoleSimple } from "central-icons/IconConsoleSimple";
import { IconWallet3 } from "central-icons/IconWallet3";
import { IconDeepSearch } from "central-icons/IconDeepSearch";
import { IconCheckCircle2 } from "central-icons/IconCheckCircle2";
import { IconConcise } from "central-icons/IconConcise";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFiles } from "central-icons/IconFiles";
import { IconFileSparkle } from "central-icons/IconFileSparkle";
import { IconFileText } from "central-icons/IconFileText";
import { IconGauge } from "central-icons/IconGauge";
import { IconGhost2 } from "central-icons/IconGhost2";
import { IconHeartBeat } from "central-icons/IconHeartBeat";
import { IconHistory } from "central-icons/IconHistory";
import { IconListBullets } from "central-icons/IconListBullets";
import { IconLock } from "central-icons/IconLock";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconPencil } from "central-icons/IconPencil";
import { IconPencilLine } from "central-icons/IconPencilLine";
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
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { HoverTip } from "../ui/HoverTip";
import { InlineNotice } from "../ui/InlineNotice";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Spinner } from "../ui/Spinner";
import {
  cancelAgentTask,
  dictationHelperCommand,
  explainAgentApproval,
  getAgentTask,
  getHermesBridgeSkill,
  ensureHermesBridgeSession,
  hermesBridgeFilesystemSnapshot,
  hermesBridgeMessagingPlatforms,
  hermesBridgeFilePreview,
  hermesBridgeFileText,
  hermesAgentCliAccess,
  hermesBridgeSkills,
  generateImage,
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
  setHermesAgentCliAccess,
  setVeniceModel,
  startHermesBridge,
  submitIssueReport,
  suggestAgentSessionTitle,
  toggleHermesBridgeSkill,
  toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform,
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
  isHermesFeatureSupported,
  isSensitiveKey,
  type HermesMode,
} from "../../lib/hermes-control-plane";
import {
  attachImageToSession,
  attachmentStateFrom,
  pendingImageAttachments,
  type HermesAttachmentState,
} from "../../lib/hermes-image-attach";
import { parseSessionUsage, type SessionUsage } from "../../lib/hermes-session-usage";
import {
  parseCompressSessionResult,
  type CompressSessionResult,
} from "../../lib/hermes-session-compress";
import {
  isBranchableMessageId,
  parseBranchSessionResult,
  type BranchSessionResult,
} from "../../lib/hermes-session-branch";
import { normalizeSteerText, steeringLiveEvent } from "../../lib/hermes-session-steer";
import { unsupportedEventStore } from "../../lib/hermes-unsupported-events";
import { pendingActionStore } from "../../lib/hermes-pending-actions";
import { hermesActivityStore } from "../../lib/hermes-activity-store";
import {
  hermesArtifactStore,
  // The store's record shape collides by name with this file's local
  // `AgentArtifact` (the file-viewer card), so alias it.
  type AgentArtifact as TimelineArtifact,
} from "../../lib/hermes-artifact-store";
import { SessionUsagePanel } from "./SessionUsagePanel";
import { AgentActivityDrawer, AgentArtifactsSection } from "./AgentActivityDrawer";
import { hermesTraceBuffer } from "../../lib/hermes-trace-buffer";
import { UnsupportedEventNotice } from "./UnsupportedEventNotice";
import { HermesTracePanel } from "./HermesTracePanel";
import {
  PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
  dispatchProviderModelSettingsChanged,
  modelPrivacyBadge,
  modelSupportsImageInput,
  modelSupportsTools,
  type ModelPrivacyBadge,
  type ProviderModelSettingsChangedDetail,
} from "../../lib/model-privacy";
import { resolveModelSwitchOutcome } from "../../lib/hermes-model-switch";
import { preferredVisionFallbackModel, suggestedModelsForMode } from "../../lib/suggested-models";
import {
  contextLabel,
  modelOptions,
  pricingLabel,
  selectedModel as selectedModelOption,
} from "../settings/ModelPickerDialog";
import { isHermesSessionsStartupRequestError, messageFromError } from "../../lib/errors";
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
import { generateChatImage } from "../../lib/chat-image-generation";
import { IMAGE_GENERATION_ENABLED } from "../../lib/feature-flags";
import { ComposerEditor, type ComposerEditorHandle } from "./composer/ComposerEditor";
import { CategoryIcon } from "./composer/CategoryIcon";
import { FileTypeIcon, fileTypeIconComponent } from "./FileTypeIcon";
import {
  isReportCategory,
  REPORT_CATEGORIES,
  type ReportCategory,
} from "./composer/reportCategory";
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
  repairContractionSpacing,
  textFromHermesContent,
  type AgentApprovalChoice,
  type AgentChatPart,
  type AgentChatTurn,
  type LiveHermesEvent,
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
   * "run" submits the prompt immediately; "prefill" drops it into the
   * composer for the user to finish (selecting the <placeholder> if there is
   * one); "attach" prefills and opens the file picker.
   */
  action: "run" | "prefill" | "attach";
};

/**
 * Suggestion pool for the new-session hero. Shown HERO_SHORTCUT_COUNT at a
 * time and reshuffled on each visit, so the entry point stays a handful of
 * fresh ideas instead of a wall of ten cards. Pool order matters: the leading
 * window is the curated first-impression mix (an instant run, a prefill, an
 * attach flow, and a health check) that shows when the shuffle is identity
 * (e.g. in tests with Math.random mocked to 0).
 *
 * Every suggestion must succeed inside the default write-jail: reads are
 * broad, but writes land only in the agent workspace. Don't add shortcuts
 * that rename, move, or delete the user's files (tidy a folder, free up
 * disk space, dedupe) — the sandbox denies the write mid-task and June's
 * own suggestion reads as broken.
 */
const AGENT_SHORTCUTS: AgentShortcut[] = [
  {
    key: "recent-files",
    icon: <IconHistory size={18} />,
    title: "Catch up on recent files",
    description: "A quick rundown of what's new across your folders.",
    prompt:
      "Look through my Desktop, Documents, and Downloads folders for files added or changed in the last week and give me a quick rundown of what's new, grouped by what they seem to be for. Don't move or change anything.",
    action: "run",
  },
  {
    key: "research",
    icon: <IconDeepSearch size={18} />,
    title: "Research a topic",
    description: "Get a short, sourced write-up on anything.",
    prompt: "Research <topic> and write a short summary of what you find, with sources.",
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
    title: "Check my computer's health",
    description: "Disk, memory, and login items that need attention.",
    prompt:
      "Give my computer a quick health check: free disk space, memory pressure, login items, and anything else worth flagging. Summarize what looks fine and what needs attention.",
    action: "run",
  },
  {
    key: "find-file",
    icon: <IconMagnifyingGlass size={18} />,
    title: "Find a file",
    description: "Describe what you remember; June tracks it down.",
    prompt: "Find <a file I half-remember> on my computer and tell me where it is.",
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
    key: "extract-text",
    icon: <IconFileText size={18} />,
    title: "Extract text from a file",
    description: "Pull clean text out of a PDF, image, or scan.",
    prompt: "Extract all the text from the attached file and clean it up into tidy Markdown.",
    action: "attach",
  },
  {
    key: "plan-project",
    icon: <IconListBullets size={18} />,
    title: "Plan a project",
    description: "Turn a vague goal into concrete first steps.",
    prompt:
      "Help me plan <a project>: break it into concrete steps, flag the risks, and suggest what to tackle first.",
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

export {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_SESSIONS_CHANGED_EVENT,
};

export type { AgentSessionsChangedDetail };

export type AgentNewSessionDetail = {
  prompt?: string;
  /** Seeds the composer with a category chip (and skips auto-submit) so the
   * user lands ready to type a tagged report instead of an ordinary message. */
  category?: ReportCategory;
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

type HermesToolEventPhase = "start" | "progress" | "complete";

type AgentWorkspaceError = {
  message: string;
  /** Null means the error belongs to the no-session workspace surface. */
  sessionId: string | null;
};

type AgentWorkspaceErrorOptions = {
  sessionId?: string | null;
};

type AgentWorkspaceNotice = {
  message: string;
  sessionId: string;
};

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
  /** Structured attach status (feature 19). Tracks whether this import has been
   * sent to the model via image.attach_bytes: imported (ready) → attached (acked) →
   * or failed. Carries file refs only, never the image bytes. Files stay
   * `imported` (they only ride along as a path in the prompt). */
  attach: HermesAttachmentState;
};

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
  crumbs: { label: string; onClick: () => void }[];
};

type AgentWorkspaceProps = {
  initialSession?: HermesSessionInfo;
  initialSessionId?: string;
  origin?: AgentWorkspaceOrigin;
  onSessionSelected?: (session: HermesSessionInfo | undefined) => void;
  onTopUp?: () => void | Promise<void>;
  topUpLabel?: string;
};

// Mid-run continuity across remounts. While June is working, a session has
// state that exists nowhere outside this component: the optimistic list entry
// (title + preview), the just-sent user bubble Hermes hasn't persisted yet,
// the working/waiting flags that drive the reconcile poll, the stored→runtime
// session mapping, the buffered live events, the title override, and any
// queued issue report draft, the review-ready report waiting for the user to
// send, and the delayed diagnosis refresh that makes the final June answer
// available to the report payload.
// Navigating away (e.g. to Settings) unmounts the workspace; without this
// snapshot the remount restores only the selected id from localStorage, and a
// session whose first turn hasn't persisted renders as an empty "Untitled
// session" that nothing ever polls back to life. Captured on unmount for the
// sessions with active work, hydrated by the next mount's state initializers
// so the working poll picks the run straight back up.
type AgentSessionContinuity = {
  sessionItems: HermesSessionInfo[];
  pendingMessages: Record<string, HermesSessionMessage[]>;
  workingSessionIds: string[];
  waitingSessionIds: string[];
  runtimeSessionIds: Record<string, string>;
  liveEvents: Record<string, LiveHermesEvent[]>;
  titleOverrides: Record<string, string>;
  activeToolCallsBySession: Record<string, Record<string, number>>;
  pendingIssueReports: Record<string, PendingIssueReport>;
  reviewableIssueReports: Record<string, PendingIssueReport>;
  diagnosisRefreshIssueReportSessionIds: string[];
  submittingIssueReportSessionIds: string[];
};

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
const ISSUE_REPORT_DELIVERY_SETTLED_EVENT = "june-agent-issue-report-delivery-settled";
const ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT =
  "june-agent-issue-report-follow-up-submit-failed";
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

function shouldOpenNewSessionOnMount() {
  return hasPendingNewSessionRequest() || hasNewSessionComposerDraft();
}

function activeToolCallsRecord(
  activeToolCallsBySession: Map<string, Map<string, number>>,
): Record<string, Record<string, number>> {
  return Object.fromEntries(
    Array.from(activeToolCallsBySession.entries())
      .filter(([, tools]) => tools.size > 0)
      .map(([sessionId, tools]) => [sessionId, Object.fromEntries(tools)]),
  );
}

function activeToolCallsMap(
  activeToolCallsBySession: Record<string, Record<string, number>> | undefined,
) {
  return new Map(
    Object.entries(activeToolCallsBySession ?? {}).map(([sessionId, tools]) => [
      sessionId,
      new Map(
        Object.entries(tools).filter(
          (entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] > 0,
        ),
      ),
    ]),
  );
}

function captureSessionContinuity(state: {
  sessionItems: HermesSessionInfo[];
  pendingMessages: Record<string, HermesSessionMessage[]>;
  workingSessionIds: Set<string>;
  waitingSessionIds: Set<string>;
  runtimeSessionIds: Record<string, string>;
  liveEvents: Record<string, LiveHermesEvent[]>;
  titleOverrides: Record<string, string>;
  activeToolCallsBySession: Record<string, Record<string, number>>;
  pendingIssueReports: Record<string, PendingIssueReport>;
  reviewableIssueReports: Record<string, PendingIssueReport>;
  diagnosisRefreshIssueReportSessionIds: Set<string>;
  submittingIssueReportSessionIds: Set<string>;
}): AgentSessionContinuity | null {
  const activeIds = new Set([...state.workingSessionIds, ...state.waitingSessionIds]);
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
  for (const sessionId of Object.keys(state.activeToolCallsBySession)) {
    activeIds.add(sessionId);
  }
  if (activeIds.size === 0) return null;
  const pick = <T,>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([sessionId]) => activeIds.has(sessionId)));
  return {
    sessionItems: state.sessionItems.filter((session) => activeIds.has(session.id)),
    pendingMessages: pick(state.pendingMessages),
    workingSessionIds: [...state.workingSessionIds],
    waitingSessionIds: [...state.waitingSessionIds],
    runtimeSessionIds: pick(state.runtimeSessionIds),
    liveEvents: pick(state.liveEvents),
    titleOverrides: pick(state.titleOverrides),
    activeToolCallsBySession: pick(state.activeToolCallsBySession),
    pendingIssueReports: pick(state.pendingIssueReports),
    reviewableIssueReports: pick(state.reviewableIssueReports),
    diagnosisRefreshIssueReportSessionIds: [...state.diagnosisRefreshIssueReportSessionIds].filter(
      (sessionId) => activeIds.has(sessionId),
    ),
    submittingIssueReportSessionIds: [...state.submittingIssueReportSessionIds].filter(
      (sessionId) => activeIds.has(sessionId),
    ),
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
    workingSessionIds: new Set(sessionContinuity.workingSessionIds),
    waitingSessionIds: new Set(sessionContinuity.waitingSessionIds),
    runtimeSessionIds: sessionContinuity.runtimeSessionIds,
    liveEvents: sessionContinuity.liveEvents,
    titleOverrides: sessionContinuity.titleOverrides,
    activeToolCallsBySession: sessionContinuity.activeToolCallsBySession,
    pendingIssueReports,
    reviewableIssueReports,
    diagnosisRefreshIssueReportSessionIds,
    submittingIssueReportSessionIds: new Set(
      sessionContinuity.submittingIssueReportSessionIds.filter(
        (sessionId) => sessionId !== detail.sessionId,
      ),
    ),
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
    workingSessionIds: new Set(sessionContinuity.workingSessionIds),
    waitingSessionIds: new Set(sessionContinuity.waitingSessionIds),
    runtimeSessionIds: sessionContinuity.runtimeSessionIds,
    liveEvents: sessionContinuity.liveEvents,
    titleOverrides: sessionContinuity.titleOverrides,
    activeToolCallsBySession: sessionContinuity.activeToolCallsBySession,
    pendingIssueReports,
    reviewableIssueReports,
    diagnosisRefreshIssueReportSessionIds: new Set(
      sessionContinuity.diagnosisRefreshIssueReportSessionIds,
    ),
    submittingIssueReportSessionIds: new Set(sessionContinuity.submittingIssueReportSessionIds),
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
}

export function AgentWorkspace({
  initialSession,
  initialSessionId: initialSessionIdProp,
  origin,
  onSessionSelected,
  onTopUp,
  topUpLabel = "Upgrade",
}: AgentWorkspaceProps = {}) {
  const initialSessionId = initialSession?.id ?? initialSessionIdProp;
  // Read once per mount (lazy initializer): the continuity snapshot the
  // previous mount captured on unmount, if any session was still mid-run.
  const [continuity] = useState(() => sessionContinuity);
  const [tasks, setTasks] = useState<AgentTaskDto[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [activePanel, setActivePanel] = useState<AgentPanel>("chat");
  const [draft, setDraft] = useState("");
  // The message's single category tag, mirrored from the composer's chip. Null
  // when the message carries no tag. Drives the report wrapper and (server
  // side) the no-charge waiver.
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
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorState, setErrorState] = useState<AgentWorkspaceError | null>(null);
  // A rejected send into a still-running session, explained by the composer.
  // Separate from `errorState` because background session refreshes clear that
  // banner on success — this notice must survive until the turn finishes.
  const [busyNotice, setBusyNotice] = useState<string | null>(null);
  // Confirmation that a submitted issue report reached the June team; shown
  // in the composer notice slot until dismissed by the next send.
  const [issueReportNotice, setIssueReportNotice] = useState<AgentWorkspaceNotice | null>(null);
  // Honest result of the last model switch (feature 10): scoped to the session
  // it acted on so it survives background refreshes and disappears when the
  // user moves to another conversation. A null sessionId means it reports a
  // default-only change shown on the hero.
  const [modelSwitchNotice, setModelSwitchNotice] = useState<{
    message: string;
    sessionId: string | null;
  } | null>(null);
  // Feature 07: after a successful fork, the banner that tells the user the
  // freshly-opened session was branched from another. Keyed by the NEW
  // session's id so it shows only while that session is selected, then clears
  // itself once they navigate away.
  const [branchedNotice, setBranchedNotice] = useState<{
    sessionId: string;
    sourceTitle: string;
  } | null>(null);
  // Which message a branch is currently in flight for, so its action shows a
  // disabled/working state and double-clicks can't fork twice.
  const [branchingMessageId, setBranchingMessageId] = useState<string | null>(null);
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
  // The "+" popover: attach files, or tag the message as a report.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachTriggerRef = useRef<HTMLButtonElement | null>(null);
  const attachMenuRef = useRef<HTMLDivElement | null>(null);
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
      setErrorState({
        message,
        sessionId:
          options.sessionId === undefined
            ? (selectedHermesSessionIdRef.current ?? null)
            : options.sessionId,
      });
    },
    [],
  );
  const handleTopUp = useCallback(() => {
    const result = onTopUp ? onTopUp() : osAccountsUpgrade();
    void Promise.resolve(result).catch((err: unknown) => setError(messageFromError(err)));
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
  const [pendingHermesMessages, setPendingHermesMessages] = useState<
    Record<string, HermesSessionMessage[]>
  >(() => continuity?.pendingMessages ?? {});
  const pendingHermesMessagesRef =
    useRef<Record<string, HermesSessionMessage[]>>(pendingHermesMessages);
  // Per-session, client-synthesized assistant turns for the `/image` slash
  // command. The generated image never comes off the gateway message stream, so
  // it can't ride in `pendingHermesMessages` (those are HermesSessionMessages);
  // it lives here as a ready-built AgentChatTurn carrying the image part inline,
  // merged into the rendered turns by createdAt. In-memory like the artifact
  // store — survives session switches, not a full app reload.
  const [imageTurnsBySession, setImageTurnsBySession] = useState<Record<string, AgentChatTurn[]>>(
    {},
  );
  // Per-session ordering for message fetches: the sequence handed out at
  // fetch start, and the highest sequence whose response was applied. See
  // listSessionMessagesOrdered.
  const sessionMessagesFetchSeqRef = useRef<Map<string, number>>(new Map());
  const sessionMessagesAppliedSeqRef = useRef<Map<string, number>>(new Map());
  const [hermesSessionsLoading, setHermesSessionsLoading] = useState(false);
  const [liveEvents, setLiveEvents] = useState<Record<string, LiveHermesEvent[]>>(
    () => continuity?.liveEvents ?? {},
  );
  const [thinkingOpenByKey, setThinkingOpenByKey] = useState<Record<string, boolean>>({});
  const [workingTaskIds, setWorkingTaskIds] = useState<Set<string>>(() => new Set());
  const [workingSessionIds, setWorkingSessionIds] = useState<Set<string>>(
    () => new Set(continuity?.workingSessionIds),
  );
  const workingSessionIdsRef = useRef<Set<string>>(workingSessionIds);
  const [toolCallSessionIds, setToolCallSessionIds] = useState<Set<string>>(
    () => new Set(Object.keys(continuity?.activeToolCallsBySession ?? {})),
  );
  const toolCallSessionIdsRef = useRef<Set<string>>(toolCallSessionIds);
  // Steers we've sent that Hermes may not have delivered yet. Hermes only
  // injects a steer into the next tool result, so a no-tool turn drops it; we
  // track the text and resend it as a follow-up on completion when no tool
  // consumed it (cleared on a tool.complete or a clean terminal).
  const pendingSteerBySessionIdRef = useRef<
    Record<string, { text: string; accepted: boolean; toolDrained: boolean }[]>
  >({});
  const activeToolCallsBySessionRef = useRef<Map<string, Map<string, number>>>(
    activeToolCallsMap(continuity?.activeToolCallsBySession),
  );
  const [waitingSessionIds, setWaitingSessionIds] = useState<Set<string>>(
    () => new Set(continuity?.waitingSessionIds),
  );
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
  const defaultGenerationModelIdRef = useRef("");
  const sessionModelOverridesRef = useRef<Record<string, string>>({});
  const [generationModels, setGenerationModels] = useState<VeniceModelDto[]>([]);
  const generationModelsRef = useRef<VeniceModelDto[]>([]);
  const [composerModelOpen, setComposerModelOpen] = useState(false);
  const [composerModelFlyout, setComposerModelFlyout] = useState<ComposerModelFlyout>(null);
  const [modelSearch, setModelSearch] = useState("");
  const composerModelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const composerModelPopoverRef = useRef<HTMLDivElement | null>(null);
  const composerModelSearchRef = useRef<HTMLInputElement | null>(null);
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
  const liveEventsRef = useRef<Record<string, LiveHermesEvent[]>>(liveEvents);
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
  const titleSuggestionSessionIdsRef = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement | null>(null);
  const agentScrollRef = useRef<HTMLDivElement | null>(null);
  const composerEditorRef = useRef<ComposerEditorHandle | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  // A category to seed into the composer chip once the editor is ready, set by
  // startNewTask for the sidebar/settings report entry points.
  const pendingSeedCategoryRef = useRef<ReportCategory | null>(null);

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
    const restoredSessionIds = continuity?.workingSessionIds ?? [];
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
    pendingHermesMessagesRef.current = pendingHermesMessages;
    hermesSessionItemsRef.current = hermesSessionItems;
  }, [
    hermesSessionItems,
    pendingHermesMessages,
    selectedHermesSessionId,
    toolCallSessionIds,
    waitingSessionIds,
    workingSessionIds,
  ]);

  const setSessionToolCallActive = useCallback((sessionId: string, active: boolean) => {
    setToolCallSessionIds((current) => {
      const next = new Set(current);
      if (active) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      toolCallSessionIdsRef.current = next;
      return next;
    });
  }, []);

  function clearSessionToolCalls(sessionId: string) {
    activeToolCallsBySessionRef.current.delete(sessionId);
    setSessionToolCallActive(sessionId, false);
  }

  function updateSessionToolCallActivity(
    sessionId: string,
    event: HermesGatewayEvent,
    phase: HermesToolEventPhase,
  ) {
    const eventKey = toolEventActivityKey(event);
    const current = new Map(activeToolCallsBySessionRef.current.get(sessionId) ?? []);

    if (phase === "progress" && eventKey === undefined) {
      return current.size > 0;
    }

    const key = eventKey ?? "__anonymous_tool__";

    if (phase === "start") {
      current.set(key, (current.get(key) ?? 0) + 1);
    } else if (phase === "progress") {
      if (!current.has(key)) current.set(key, 1);
    } else {
      const count = current.get(key) ?? 0;
      if (count > 1) {
        current.set(key, count - 1);
      } else {
        current.delete(key);
      }
    }

    if (current.size > 0) {
      activeToolCallsBySessionRef.current.set(sessionId, current);
      setSessionToolCallActive(sessionId, true);
      return true;
    }

    activeToolCallsBySessionRef.current.delete(sessionId);
    setSessionToolCallActive(sessionId, false);
    return false;
  }

  const setSessionWorking = useCallback((sessionId: string, working: boolean) => {
    setWorkingSessionIds((current) => {
      const next = new Set(current);
      if (working) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      workingSessionIdsRef.current = next;
      return next;
    });
  }, []);

  const setSessionWaiting = useCallback((sessionId: string, waiting: boolean) => {
    setWaitingSessionIds((current) => {
      const next = new Set(current);
      if (waiting) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      waitingSessionIdsRef.current = next;
      return next;
    });
  }, []);

  const clearSessionActivity = useCallback(
    (sessionId: string) => {
      clearSessionToolCalls(sessionId);

      const nextWorking = new Set(workingSessionIdsRef.current);
      nextWorking.delete(sessionId);
      workingSessionIdsRef.current = nextWorking;
      setWorkingSessionIds(nextWorking);

      const nextWaiting = new Set(waitingSessionIdsRef.current);
      nextWaiting.delete(sessionId);
      waitingSessionIdsRef.current = nextWaiting;
      setWaitingSessionIds(nextWaiting);

      return {
        activeCount: nextWorking.size + nextWaiting.size,
        needsUserCount: nextWaiting.size,
      };
    },
    [setSessionToolCallActive],
  );

  // Shared teardown for a session that is going away: its messages, pending
  // sends, working/waiting flags, live gateway listener, and buffered live
  // events. Both delete paths (sidebar event and session-bar menu) run this so
  // neither leaves a phantom "working" session with a leaked listener behind.
  const scrubHermesSessionState = useCallback(
    (sessionId: string) => {
      setHermesSessionMessages((current) => omitRecordKey(current, sessionId));
      setPendingHermesMessages((current) => {
        const next = omitRecordKey(current, sessionId);
        pendingHermesMessagesRef.current = next;
        return next;
      });
      clearSessionActivity(sessionId);
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
    },
    [clearSessionActivity],
  );

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
  const activeGenerationModelId =
    selectedHermesSessionId && !newSessionMode
      ? selectedHermesSession?.model?.trim() || defaultGenerationModelId
      : defaultGenerationModelId;
  const generationModel = useMemo(
    () =>
      activeGenerationModelId
        ? selectedModelOption(generationModels, activeGenerationModelId)
        : undefined,
    [activeGenerationModelId, generationModels],
  );
  const generationPrivacyBadge = generationModel ? modelPrivacyBadge(generationModel) : undefined;
  // The model the image-attach banner offers to switch to: a vision + tool
  // capable model, preferring a curated suggested pick (Kimi K2.6) over the
  // alphabetically-first vision model. See preferredVisionFallbackModel.
  const preferredVisionModel = useMemo(
    () => preferredVisionFallbackModel(generationModels),
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
  const showImageInputWarning =
    composerHasPendingImage &&
    !!resolvedGenerationModel &&
    !modelSupportsImageInput(resolvedGenerationModel);
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
  const visibleError = visibleAgentWorkspaceError(errorState, selectedHermesSessionId);
  const visibleIssueReportNotice =
    issueReportNotice && issueReportNotice.sessionId === selectedHermesSessionId
      ? issueReportNotice.message
      : null;
  // The model-switch notice (feature 10) shows on the session it acted on; a
  // null sessionId is the default-only notice, shown while no session is open.
  const visibleModelSwitchNotice =
    modelSwitchNotice && modelSwitchNotice.sessionId === (selectedHermesSessionId ?? null)
      ? modelSwitchNotice.message
      : null;
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
    async (options: { suppressStartupRequestError?: boolean } = {}) => {
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
            sessionModelOverrides: sessionModelOverridesRef.current,
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
        if (
          options.suppressStartupRequestError &&
          !hermesSessionsHydratedRef.current &&
          isHermesSessionsStartupRequestError(err)
        ) {
          keepLoading = true;
          return "transient-startup-error";
        }
        setError(messageFromError(err));
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
      const selectedModelId =
        settingsResponse.settings.generationModel || modelsResponse.selectedModel;
      if (requestId === generationModelRequestSequence.current) {
        defaultGenerationModelIdRef.current = selectedModelId;
        generationModelsRef.current = modelsResponse.models;
        setGenerationModels(modelsResponse.models);
        setDefaultGenerationModelId(selectedModelId);
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
  }, []);

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

  // Stale catalog (the mount fetch can fail while the bridge is starting) is
  // refreshed in the background on every open, like Settings does.
  function openComposerModelPicker() {
    setModelSearch("");
    setComposerModelFlyout(null);
    setComposerModelOpen(true);
    setSandboxMenuOpen(false);
    void loadGenerationModel();
  }

  // Switching the model always writes the global text-model default (Settings'
  // model rows and this pill refresh through the same changed event). When a
  // session is open, it ALSO switches that live session via Hermes
  // command.dispatch (/model …) — and the UI only claims the running session
  // moved when Hermes accepts the dispatch (feature 10). The gateway result is
  // the source of truth: raw model.switch/model.changed frames classify as
  // unsupported, so there is no confirming event to wait on.
  async function handleSelectGenerationModel(modelId: string) {
    setComposerModelOpen(false);
    const chosen = generationModelsRef.current.find((model) => model.id === modelId);
    // Defense in depth: the picker already hides tool-less models, but the
    // agent bricks without function calling, so refuse one rather than switch.
    if (chosen && !modelSupportsTools(chosen)) {
      setError(`${chosen.name} can't run June's tools, so it can't be used for the agent.`);
      return false;
    }
    const modelName = chosen?.name ?? modelId;
    const sessionId = newSessionModeRef.current ? undefined : selectedHermesSessionIdRef.current;

    // No open chat: changing the model updates the global generation default.
    if (!sessionId) {
      try {
        await setVeniceModel("generation", modelId);
        defaultGenerationModelIdRef.current = modelId;
        setDefaultGenerationModelId(modelId);
        dispatchProviderModelSettingsChanged({ mode: "generation", modelId });
        setError(null);
      } catch (err) {
        setError(messageFromError(err));
        return false;
      }
      setModelSwitchNotice({
        message: resolveModelSwitchOutcome({
          hasActiveSession: false,
          dispatchSucceeded: false,
          modelName,
        }).notice,
        sessionId: null,
      });
      return true;
    }

    // Open chat: override the model for THIS chat only (never the global
    // default), then dispatch /model to the live session so the running turn
    // switches immediately. Hermes session metadata updates are title-only, so
    // the local per-chat override is the source of truth for this row.
    sessionModelOverridesRef.current = {
      ...sessionModelOverridesRef.current,
      [sessionId]: modelId,
    };
    setHermesSessionItems((current) =>
      current.map((session) =>
        session.id === sessionId ? { ...session, model: modelId } : session,
      ),
    );
    let dispatchSucceeded = false;
    try {
      const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
      await createHermesMethods(gateway).switchActiveSessionModel({
        mode: hermesModeFor(sessionId),
        sessionId,
        model: modelId,
      });
      dispatchSucceeded = true;
    } catch {
      // The per-chat override is saved; the notice explains the running session
      // is unchanged and the new model applies next session.
      dispatchSucceeded = false;
    }
    setError(null);
    setModelSwitchNotice({
      message: resolveModelSwitchOutcome({
        hasActiveSession: true,
        dispatchSucceeded,
        modelName,
      }).notice,
      sessionId,
    });
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
    startNewTask,
    removeHermesSessionLocally,
  });
  useEffect(() => {
    windowEventHandlersRef.current = {
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

    const pending = pendingNewSessionRequest();
    if (pending) {
      void windowEventHandlersRef.current.startNewTask(pending, {
        deferCategorySeed: true,
      });
    }

    window.addEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
    window.addEventListener(AGENT_DELETE_SESSION_EVENT, handleDeleteSession);
    return () => {
      window.removeEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
      window.removeEventListener(AGENT_DELETE_SESSION_EVENT, handleDeleteSession);
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
        setHermesSessionMessages((current) => ({
          ...current,
          [selectedHermesSessionId]: messages,
        }));
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
          setSessionWorking(selectedHermesSessionId, true);
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
        setError(message, { sessionId: selectedHermesSessionId });
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
        if (!cancelled) setError(messageFromError(err));
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
        if (!cancelled) setError(messageFromError(err));
      }
    })();
    return () => {
      cancelled = true;
      // Keep any mid-run session alive for the next mount before the
      // gateways (and with them the live event streams) go away.
      sessionContinuity = captureSessionContinuity({
        sessionItems: hermesSessionItemsRef.current,
        pendingMessages: pendingHermesMessagesRef.current,
        workingSessionIds: workingSessionIdsRef.current,
        waitingSessionIds: waitingSessionIdsRef.current,
        runtimeSessionIds: runtimeSessionIdsRef.current,
        liveEvents: liveEventsRef.current,
        titleOverrides: sessionTitleOverridesRef.current,
        activeToolCallsBySession: activeToolCallsRecord(activeToolCallsBySessionRef.current),
        pendingIssueReports: Object.fromEntries(pendingIssueReportsRef.current),
        reviewableIssueReports: reviewableIssueReportsRef.current,
        diagnosisRefreshIssueReportSessionIds: diagnosisRefreshIssueReportSessionIdsRef.current,
        submittingIssueReportSessionIds: submittingIssueReportSessionIdsRef.current,
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
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const installListener = async (eventName: string) => {
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
    void installListener("tauri://drag-drop");
    void installListener("tauri://file-drop");
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

  // The busy notice's advice ("wait for the reply") expires the moment the
  // selected session stops working — including when the user switches to a
  // session that isn't running.
  useEffect(() => {
    if (!busyNotice) return;
    if (selectedHermesSessionId && workingSessionIds.has(selectedHermesSessionId)) return;
    setBusyNotice(null);
  }, [busyNotice, selectedHermesSessionId, workingSessionIds]);

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

    await runFileSlashCommand(parsed.argument, commandText);
    return true;
  }

  // `/image <prompt>` renders the generated image inline in the chat as an
  // assistant turn (loader -> image, with view + download), NOT as a composer
  // attachment chip. It creates/uses a real session and the prompt becomes a
  // user turn, but the model is never invoked — the image endpoint IS the whole
  // response (see submitHermesSession's `skipPrompt`). The image model is
  // resolved server-side from the saved default.
  async function runImageSlashCommand(argument: string, commandText: string) {
    const prompt = argument.trim();
    if (!prompt) {
      setError("Type a description after /image to generate an image.");
      return;
    }

    // The prompt is about to become a user turn — clear the draft up front and,
    // on a fresh session, play the hero teardown so the conversation view takes
    // over while the session is created.
    const heroMode = newSessionModeRef.current;
    if (heroMode) setHeroLeaving(true);
    clearComposerCommandDraft(commandText);
    setError(null);
    // Busy-gate the WHOLE flow (session create + generation) via the same
    // importingFiles flag submit() and the send button already check, so a
    // second Enter or /image can't launch another billable generation while this
    // one is in flight. generatingImage only tailors the placeholder copy.
    setImportingFiles(true);
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

    // Inject a running assistant turn so the loader shows immediately, ordered
    // just after the user prompt bubble (createdAt + 1ms).
    const turnId = `image:${sessionId}:${Date.now()}`;
    const updateImagePart = (patch: Partial<Extract<AgentChatPart, { type: "image" }>>) =>
      setImageTurnsBySession((current) => {
        const turns = current[sessionId] ?? [];
        return {
          ...current,
          [sessionId]: turns.map((turn) => {
            if (turn.id !== turnId) return turn;
            const parts = turn.parts.map((part) =>
              part.type === "image" ? { ...part, ...patch } : part,
            );
            const running = parts.some(
              (part) => part.type === "image" && part.status === "running",
            );
            return { ...turn, parts, status: running ? "running" : "complete" };
          }),
        };
      });

    setImageTurnsBySession((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
        {
          id: turnId,
          role: "assistant",
          createdAt: new Date(Date.now() + 1).toISOString(),
          status: "running",
          parts: [{ type: "image", status: "running", prompt }],
        },
      ],
    }));

    try {
      const result = await generateChatImage(prompt, {
        generate: (text, model) => generateImage(text, model),
        importImageBytes: importHermesBridgeFileBytes,
      });
      if (result.status !== "ok") {
        updateImagePart({ status: "error", error: result.message });
        return;
      }
      updateImagePart({
        status: "complete",
        dataUrl: result.dataUrl,
        path: result.file.path,
        name: result.file.name,
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
    } catch (err) {
      updateImagePart({ status: "error", error: messageFromError(err) });
    } finally {
      setGeneratingImage(false);
      setImportingFiles(false);
    }
  }

  async function runModelSlashCommand(argument: string, commandText: string) {
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
      selectedHermesSessionIsProvisional
    )
      return;
    if (message && (await handleBuiltinComposerSlashCommand(message))) return;
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
      const steerSessionId = selectedHermesSessionId;
      // Delivery guarantee. Hermes only injects a steer into the next tool
      // result and rejects the RPC during a no-tool phase, so the steer alone
      // is unreliable. Record the text, attempt the steer (best effort — a
      // success a tool later drains is the mid-run path), and on the turn's
      // clean completion resend anything still pending as a follow-up.
      // `registered` tracks whether Hermes accepted the steer, so a
      // tool.complete only clears ones a tool could actually have drained.
      const steerEntry = { text: message, accepted: false, toolDrained: false };
      pendingSteerBySessionIdRef.current = {
        ...pendingSteerBySessionIdRef.current,
        [steerSessionId]: [
          ...(pendingSteerBySessionIdRef.current[steerSessionId] ?? []),
          steerEntry,
        ],
      };
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
    // A typed hero submit plays the same teardown as a run shortcut: greeting
    // up, suggestions down during the session-create latency. Without it they
    // sit frozen through the wait and then vanish in a single frame when the
    // conversation takes over.
    if (heroMode) setHeroLeaving(true);
    setSubmitting(true);
    let clearedDraft = false;
    let clearedAttachments = false;
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
      const nextIssueReport: PendingIssueReport | undefined = reportCategory
        ? {
            category: reportCategory,
            // An attachments-only send has no typed text, but the server
            // requires a description; the report must not bounce there.
            description: prepared.typedMessage || "No description was typed; see the attachments.",
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
      setIssueReportNotice(null);
      await submitHermesSession(
        reportCategory
          ? categoryPrompt(reportCategory, prepared.runtimeContent)
          : prepared.runtimeContent,
        undefined,
        {
          displayContent: prepared.displayContent,
          titleContent: prepared.titleContent,
          attachments,
          ...(nextIssueReport ? { issueReport: nextIssueReport } : {}),
        },
      );
      if (reportFollowUpSessionId) {
        deferredFailedIssueReportDeliverySessionIdsRef.current.delete(reportFollowUpSessionId);
      }
      setError(null);
      setBusyNotice(null);
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
        const restore = err instanceof AttachBlockedError ? err.attachments : attachments;
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
        // connection banner along with showing the notice.
        setError(null);
        setBusyNotice(SESSION_BUSY_NOTICE);
      } else {
        setError(messageFromError(err));
      }
    } finally {
      setSubmitting(false);
      // On success the hero is gone; on failure this fades the greeting and
      // suggestions back in behind the restored draft.
      setHeroLeaving(false);
      // Keep the typing flow after a send: a new-session send re-mounts the
      // composer, so defer a frame to focus the live instance — otherwise focus
      // is dropped and can land on the always-on-top agent HUD.
      window.requestAnimationFrame(() => composerEditorRef.current?.focus());
    }
  }

  function handleComposerDragOver(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }

  function handleComposerDrop(event: DragEvent<HTMLFormElement>) {
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
    const files = clipboardImageFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    void importPastedImageFiles(files);
  }

  async function importAttachments<T>(
    items: T[],
    importItem: (item: T) => Promise<ImportedHermesFile>,
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
      setComposerAttachments((current) => [
        ...current,
        ...imported.map((file) => ({
          ...file,
          id: `${file.path}:${Date.now()}:${Math.random().toString(36)}`,
          // Seed the structured attach status (feature 19). Images become
          // `kind:"image"`, status `imported` — eligible for structured attach on
          // the next submit. No bytes are kept here.
          attach: attachmentStateFrom(file),
        })),
      ]);
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
  async function importDroppedFilePaths(paths: string[]) {
    const uniquePaths = Array.from(new Set(paths.map((path) => path.trim())))
      .filter(Boolean)
      .slice(0, 8);
    return importAttachments(uniquePaths, importHermesBridgeFile);
  }

  // DOM drops are how Finder files actually arrive: Tauri's drag-drop
  // interception is disabled (it has to be, so notes can use HTML5 drag into
  // folders) and WKWebView never exposes filesystem paths on dropped Files —
  // so read each blob and import its bytes.
  async function importDroppedFiles(files: File[]) {
    await importFileBytes(files, {
      tooLargeMessage: "Dropped files must be 50 MB or smaller.",
      readErrorMessage: (file) =>
        // Reading fails for directories, which Finder happily lets you drop.
        `Could not read "${file.name}". Folders can't be attached.`,
    });
  }

  async function importPastedImageFiles(files: File[]) {
    await importFileBytes(files, {
      tooLargeMessage: "Pasted images must be 50 MB or smaller.",
      readErrorMessage: () => "Could not read the pasted image.",
    });
  }

  async function importFileBytes(files: File[], options: FileBytesImportOptions) {
    await importAttachments(files.slice(0, 8), async (file) => {
      if (file.size > 50 * 1024 * 1024) {
        throw new Error(options.tooLargeMessage);
      }
      const bytes = await readFileBytes(file).catch(() => {
        throw new Error(options.readErrorMessage(file));
      });
      return importHermesBridgeFileBytes(file.name, bytes);
    });
  }

  function removeAttachment(id: string) {
    setComposerAttachments((current) => current.filter((item) => item.id !== id));
  }

  // Focus the composer, then toggle the dictation helper's listening state —
  // the same command the hotkey path sends. The helper records, shows the HUD,
  // and pastes the transcription into the focused field (the composer).
  async function startDictation() {
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
  async function pickAttachments() {
    try {
      const selected = await openFileDialog({
        multiple: true,
        title: "Attach files",
      });
      if (!selected) return false;
      const paths = Array.isArray(selected) ? selected : [selected];
      return await importDroppedFilePaths(paths);
    } catch (err) {
      setError(messageFromError(err));
      return false;
    }
  }

  // A success notice about one report reads fine anywhere, but not stale on
  // a conversation the user opened later.
  useEffect(() => {
    setIssueReportNotice(null);
  }, [selectedHermesSessionId]);

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
      await submitIssueReport({
        category: report.category,
        description: issueReportDescription(report),
        agentDiagnosis,
        attachmentNames: report.attachmentNames,
        attachmentPaths: report.attachmentPaths,
        sessionId,
      });
      clearErrorForSession(sessionId);
      if (selectedHermesSessionIdRef.current === sessionId) {
        setIssueReportNotice({
          message: "Your report was sent to the June team. Thank you for helping improve June.",
          sessionId,
        });
      }
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

  /**
   * Attach this turn's pending images to the live session via image.attach_bytes
   * (feature 19), updating each chip's status and feeding the artifact timeline.
   * The base64 is read on demand from the workspace file (hermesBridgeFilePreview
   * returns a data url), passed straight to the typed attachImage, and discarded;
   * it never lands on composer state and the trace entry is redacted to a byte
   * count. Throws a single blocking error if any image failed so the prompt is
   * not sent with a missing image.
   */
  async function attachPendingImages(
    gateway: HermesGatewayClient,
    runtimeSessionId: string,
    storedSessionId: string,
    turnAttachments: AgentAttachment[],
  ) {
    const pending = pendingImageAttachments(turnAttachments.map((attachment) => attachment.attach));
    if (!pending.length) return;
    const methods = createHermesMethods(gateway);
    const deps = {
      attachImage: methods.attachImage,
      readImageData: (path: string) => hermesBridgeFilePreview(path),
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
    setSessionWorking(sessionId, true);
    setSessionWaiting(sessionId, false);
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
    setHermesSessionMessages((current) => moveRecordKey(current, fromSessionId, toSessionId));
    setPendingHermesMessages((current) => {
      const next = moveRecordKey(current, fromSessionId, toSessionId);
      pendingHermesMessagesRef.current = next;
      return next;
    });
    liveEventsRef.current = moveRecordKey(liveEventsRef.current, fromSessionId, toSessionId);
    setLiveEvents(liveEventsRef.current);
    setWorkingSessionIds((current) => {
      const next = new Set(current);
      if (next.delete(fromSessionId)) next.add(toSessionId);
      workingSessionIdsRef.current = next;
      return next;
    });
    setWaitingSessionIds((current) => {
      const next = new Set(current);
      if (next.delete(fromSessionId)) next.add(toSessionId);
      waitingSessionIdsRef.current = next;
      return next;
    });
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
    setWorkingSessionIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      workingSessionIdsRef.current = next;
      return next;
    });
    setWaitingSessionIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      waitingSessionIdsRef.current = next;
      return next;
    });
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
      // Run every live frame through the typed control plane alongside the
      // existing string-based handling below. This is the first consumer of
      // the classifier: it doesn't drive rendering yet (later features migrate
      // families onto it incrementally), but it proves the live path is typed
      // and surfaces any raw type June can't yet model. Unknown frames classify
      // as `unsupported` rather than being dropped, so a Hermes upgrade that
      // adds an event shows up in dev instead of silently doing nothing.
      const classified = classifyHermesEvent(liveEvent);
      // Feature 15: record every inbound frame (raw type + the kind it
      // classified to) into the bounded, sanitized trace buffer so the dev/debug
      // trace panel can reconstruct the session. recordInbound re-classifies and
      // sanitizes internally; nothing raw is retained.
      hermesTraceBuffer.recordInbound(liveEvent);
      if (classified.kind === "unsupported") {
        // Feed the bounded per-session store so the user gets a recoverable
        // notice (when this is the active session) and developers get a
        // sanitized, issue-report-safe export. The payload is already sanitized
        // by the classifier; nothing raw is retained or logged.
        unsupportedEventStore.record(classified);
        if (import.meta.env.DEV) {
          // biome-ignore lint/suspicious/noConsole: dev-only unsupported-event diagnostic
          console.debug(
            "[hermes] unsupported event",
            classified.rawType,
            classified.sanitizedPayload,
          );
        }
      } else if (classified.kind === "pending_action") {
        // Feature 04: aggregate this blocker into the pending-action store
        // keyed by mode + session + request. The session's mode comes from its
        // recorded opt-in (sudo carries its own; the rest derive it here). A
        // fresh event for a known request also re-confirms a row that went
        // stale across a reconnect (see the store's reconcile logic).
        pendingActionStore.record(classified, hermesModeFor(storedSessionId));
      }
      // Feature 11: roll EVERY classified event into the global activity store
      // that backs the Agent activity drawer. The store is total and ignores
      // unattributable events, so one unconditional call covers all kinds; it
      // derives the session's phase (running/waiting/background/error/complete),
      // current tool, and subagent count from the normalized event — never from
      // the raw frame (raw JSON belongs to feature 15's trace panel).
      hermesActivityStore.record(classified, hermesModeFor(storedSessionId));
      // Feature 14: extract any file/artifact reference this event carries into
      // the per-session artifact timeline behind the drawer's "Artifacts"
      // section. The store is total and only acts on `tool` completions that
      // name a known file/url field (conservative — never parses prose), so one
      // unconditional call is safe for every kind. Mode rides along so each
      // artifact can show its blast radius (sandboxed copy vs unrestricted path).
      hermesArtifactStore.record(classified, hermesModeFor(storedSessionId));
      const nextSessionEvents = [
        ...(liveEventsRef.current[storedSessionId] ?? []),
        liveEvent,
      ].slice(-200);
      liveEventsRef.current = {
        ...liveEventsRef.current,
        [storedSessionId]: nextSessionEvents,
      };
      setLiveEvents(liveEventsRef.current);
      const toolEventPhase = hermesToolEventPhase(event.type);
      if (toolEventPhase === "complete") {
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
      const hasActiveToolCalls =
        toolEventPhase !== undefined
          ? updateSessionToolCallActivity(storedSessionId, event, toolEventPhase)
          : toolCallSessionIdsRef.current.has(storedSessionId);
      const status = agentStatusFromHermesEvent(event);
      if (status === "waitingForUser") {
        setSessionWorking(storedSessionId, false);
        setSessionWaiting(storedSessionId, true);
      } else if (status === "running") {
        setSessionWaiting(storedSessionId, false);
        setSessionWorking(storedSessionId, true);
      }
      const activityCounts =
        status === "completed" || status === "failed" || status === "cancelled"
          ? clearSessionActivity(storedSessionId)
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
          summary: agentStatusSummaryFromHermesEvent(event, status),
          ...activityCounts,
        });
      }
      if (isTerminalHermesEvent(event.type)) {
        unlisten();
        if (!activityCounts) {
          clearSessionActivity(storedSessionId);
        }
        // Delivery guarantee: any steer not consumed by a tool result this turn
        // (Hermes only injects steers into tool output) would otherwise be lost.
        // On a clean completion resend the leftovers as a follow-up so the
        // message always reaches June; drop them on a failed/cancelled run.
        const unconsumedSteers =
          status === "completed"
            ? pendingSteerBySessionIdRef.current[storedSessionId]?.filter(
                // Consumed = Hermes accepted it AND a tool result drained it.
                // Resend the rest (rejected, or accepted but no tool ran).
                (entry) => !(entry.accepted && entry.toolDrained),
              )
            : undefined;
        delete pendingSteerBySessionIdRef.current[storedSessionId];
        if (unconsumedSteers?.length) {
          const followUpSession = hermesSessionItemsRef.current.find(
            (session) => session.id === storedSessionId,
          );
          if (followUpSession) {
            const followUpText = unconsumedSteers.map((entry) => entry.text).join("\n");
            window.setTimeout(() => {
              void submitHermesSession(followUpText, followUpSession).catch((err: unknown) => {
                // The follow-up never reached June (e.g. a gateway reconnect
                // or a still-busy session right after completion). Surface it
                // rather than silently losing the instruction.
                setError(messageFromError(err), {
                  sessionId: storedSessionId,
                });
              });
            }, 0);
          }
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
      /** Create + select the session and add the user bubble, then stop BEFORE
       * `prompt.submit` (the `/image` flow): the model is never invoked, and the
       * caller renders the result itself. Returns the stored session id so the
       * caller can attach its own turns. Forces the non-optimistic create path so
       * the selected id is the canonical stored id (optimistic migration doesn't
       * move the selection). */
      skipPrompt?: boolean;
    },
  ): Promise<string | undefined> {
    const displayContent = options?.displayContent ?? content;
    const titleContent = options?.titleContent ?? displayContent;
    const targetSessionId = explicitSession?.id
      ? explicitSession.id
      : newSessionModeRef.current
        ? undefined
        : selectedHermesSessionId;
    const targetSessionModelId = targetSessionId
      ? explicitSession?.model?.trim() ||
        hermesSessionItemsRef.current
          .find((session) => session.id === targetSessionId)
          ?.model?.trim() ||
        defaultGenerationModelId
      : defaultGenerationModelId;
    const turnAttachments = options?.attachments ?? [];
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
    const promptSubmitContent = imageInputFallbackContent ?? content;
    // Issue reports skip title suggestion: the content is the wrapped
    // investigation prompt, which would title the session after the wrapper.
    const titlePromise =
      targetSessionId || options?.issueReport
        ? undefined
        : agentSessionTitleForPrompt(titleContent);
    const fallbackSessionTitle = options?.issueReport
      ? "Issue report"
      : explicitSession?.title?.trim() ||
        explicitSession?.preview?.trim() ||
        titleFromPrompt(titleContent);
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
        title: sessionDisplayTitle,
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
        runtimeSessionIds[storedSessionId] ??
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
        await attachPendingImages(gateway, runtimeSessionId, storedSessionId, turnAttachments);
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
      newSessionModeRef.current = false;
      setNewSessionMode(false);
      selectedHermesSessionIdRef.current = storedSessionId;
      setSelectedHermesSessionId(storedSessionId);
      setSelectedTaskId(undefined);
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
    if (!optimisticSession) {
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
    setSessionWorking(storedSessionId, true);
    setSessionWaiting(storedSessionId, false);
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
      setSessionWorking(storedSessionId, false);
      setSessionWaiting(storedSessionId, false);
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
    } catch (err) {
      setError(messageFromError(err));
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
      const activityCounts = clearSessionActivity(sessionId);
      // "completed" (not "failed") keeps the status quiet: its title falls back
      // to lastStatus when nothing is active, and a stale "running" there
      // would still render "Working…".
      dispatchAgentSessionStatus({
        sessionId,
        title:
          hermesSessionItems.find((session) => session.id === sessionId)?.title ?? "Agent session",
        status: "completed",
        summary: "June stopped.",
        ...activityCounts,
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
      if (!messages) return;
      const retainedPending = retainUnpersistedPendingMessages(
        pendingHermesMessagesRef.current[sessionId] ?? [],
        messages,
      );
      setHermesSessionMessages((current) => ({
        ...current,
        [sessionId]: messages,
      }));
      setPendingHermesMessages((current) => {
        const next = {
          ...current,
          [sessionId]: retainedPending,
        };
        pendingHermesMessagesRef.current = next;
        return next;
      });
      void suggestTitleForUntitledSession(sessionId, messages);
      if (sessionHasAssistantAfterLatestUser([...messages, ...retainedPending])) {
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
        }
        liveEventsRef.current = { ...liveEventsRef.current, [sessionId]: [] };
        setLiveEvents(liveEventsRef.current);
      }
      await loadHermesSessions();
    } catch (err) {
      const message = messageFromError(err);
      // Background refresh racing a just-created session: a transient
      // "Session not found" 404 resolves on the next poll, so don't surface
      // it as an error banner (JUN-116).
      if (isSessionGoneError(message)) return;
      setError(message, { sessionId });
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
      pushLiveEvent(liveEventKey, {
        type: "approval.response",
        session_id: sessionId,
        payload: { request_id: requestId, choice },
      });
      // Feature 04: the user just answered this approval — clear its global
      // "Needs you" row immediately (the response itself is the resolution).
      pendingActionStore.resolveRequest(sessionId, requestId);
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
        pendingActionStore.resolveRequest(sessionId, requestId);
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
      pushLiveEvent(liveEventKey, {
        type: "clarify.response",
        payload: { request_id: requestId, answer },
      });
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
      pushLiveEvent(liveEventKey, {
        type: "sudo.response",
        session_id: sessionId,
        payload: { request_id: requestId, granted: approved, mode },
      });
      // Feature 04: the user resolved the sudo prompt — clear its pending record.
      pendingActionStore.resolveRequest(sessionId, requestId);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime is gone, so this prompt can never be answered — retire
        // its card and say so plainly instead of leaking the raw 404.
        pendingActionStore.resolveRequest(sessionId, requestId);
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
      pushLiveEvent(liveEventKey, {
        type: "secret.response",
        session_id: sessionId,
        payload: { request_id: requestId, provided: true },
      });
      // Feature 04: the user provided the secret — clear its pending record.
      pendingActionStore.resolveRequest(sessionId, requestId);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime is gone, so this secret prompt can never be answered —
        // retire its card and say so plainly instead of leaking the raw 404.
        pendingActionStore.resolveRequest(sessionId, requestId);
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
    if (branchingMessageId) return;
    if (!sessionId) {
      setError("Cannot branch from this message because its session is unavailable.", {
        sessionId: modeSessionId ?? null,
      });
      return;
    }
    setBranchingMessageId(fromMessageId);
    const sourceTitle =
      hermesSessionItems.find((session) => session.id === sessionId || session.id === modeSessionId)
        ?.title ?? "this session";
    const unrestricted = sessionUnrestricted(modeSessionId);
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      const raw = await createHermesMethods(gateway).branchSession({
        sessionId,
        fromMessageId,
      });
      const result: BranchSessionResult | undefined = parseBranchSessionResult(raw, {
        sourceSessionId: sessionId,
        sourceMessageId: fromMessageId,
      });
      if (!result) {
        throw new Error("Hermes did not return a branched session.");
      }
      // Carry the source session's write-access mode onto the fork so its
      // follow-ups route to the matching runtime (mirrors session.create).
      rememberSessionMode(result.sessionId, unrestricted);
      // Open the fork. Selecting it triggers the message-fetch effect, which
      // fills the forked transcript. The source session is left untouched.
      newSessionModeRef.current = false;
      setNewSessionMode(false);
      setSelectedTaskId(undefined);
      selectedHermesSessionIdRef.current = result.sessionId;
      setSelectedHermesSessionId(result.sessionId);
      setActivePanel("chat");
      setBranchedNotice({ sessionId: result.sessionId, sourceTitle });
      setError(null);
      await loadHermesSessions();
    } catch (err) {
      // Leave the UI in the source session; surface the failure there.
      setError(messageFromError(err), { sessionId });
    } finally {
      setBranchingMessageId(null);
    }
  }

  function pushLiveEvent(key: string, event: HermesGatewayEvent) {
    const liveEvent = { ...event, receivedAt: new Date().toISOString() };
    const nextEvents = [...(liveEventsRef.current[key] ?? []), liveEvent].slice(-200);
    liveEventsRef.current = {
      ...liveEventsRef.current,
      [key]: nextEvents,
    };
    setLiveEvents(liveEventsRef.current);
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
    // Show the instruction in the transcript right away so the user sees it
    // landed — the gateway ack can lag a beat behind a fast send, and we never
    // want a sent message to silently vanish.
    pushLiveEvent(
      sessionId,
      steeringLiveEvent({
        sessionId,
        text: instruction,
        receivedAt: new Date().toISOString(),
      }),
    );
    const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
    await createHermesMethods(gateway).steerSession({
      sessionId,
      text: instruction,
    });
  }

  async function startNewTask(
    request?: AgentNewSessionDetail,
    options: { deferCategorySeed?: boolean } = {},
  ) {
    clearPendingNewSessionRequest();
    const seedCategory = request?.category ?? null;
    // A seeded report never auto-submits: the category chip lands in the
    // composer for the user to type their report after, whatever prompt the
    // request carried.
    const initialPrompt = seedCategory ? "" : (request?.prompt?.trim() ?? "");
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
    // Seed the composer: a category chip for a report, the prompt otherwise.
    // The editor may not be mounted yet on a cold open, so stash the category
    // for ComposerEditor's onReady to pick up and also try to apply now.
    pendingSeedCategoryRef.current = seedCategory;
    if (seedCategory) {
      clearComposerDraft(NEW_SESSION_DRAFT_KEY);
      seedComposerCategory({ defer: options.deferCategorySeed });
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

  function editUserPrompt(text: string) {
    composerEditorRef.current?.setContent(text, null);
    setDraft(text);
    setCategory(null);
    draftRef.current = text;
    categoryRef.current = null;
    setComposerAttachments([]);
    rememberComposerDraft(composerDraftKeyRef.current, text, null, []);
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

  /** Applies any pending seed category to the composer chip once the editor is
   * available. Called from startNewTask (best-effort, the editor may not be
   * mounted yet) and again from ComposerEditor's onReady. */
  function seedComposerCategory(options: { defer?: boolean } = {}) {
    if (!pendingSeedCategoryRef.current) return;
    const editor = composerEditorRef.current;
    // Not mounted yet (cold open) — leave it pending for onReady to apply.
    if (!editor) return;
    const applySeed = () => {
      const seed = pendingSeedCategoryRef.current;
      const currentEditor = composerEditorRef.current;
      if (!seed || !currentEditor) return;
      pendingSeedCategoryRef.current = null;
      draftRef.current = "";
      categoryRef.current = seed;
      setDraft("");
      setCategory(seed);
      rememberComposerDraft(NEW_SESSION_DRAFT_KEY, "", seed);
      restoredComposerDraftKeyRef.current = NEW_SESSION_DRAFT_KEY;
      currentEditor.setContent("", seed);
    };
    if (options.defer) {
      window.setTimeout(applySeed, 0);
    } else {
      applySeed();
    }
  }

  // Run shortcuts fire the session directly — the prompt never touches the
  // composer, so there's no flash of text + send button before the submit.
  // The hero plays its exit transition during the session-create latency.
  async function launchShortcutSession(prompt: string) {
    if (submitting || importingFiles) return;
    setHeroLeaving(true);
    dispatchAgentSessionStatus({
      prompt,
      title: titleFromPrompt(prompt),
      status: "starting",
      summary: "Starting June.",
    });
    setSubmitting(true);
    try {
      await submitHermesSession(prompt);
      setError(null);
    } catch (err) {
      // Bring the hero back and park the prompt in the composer so the user
      // can see what would have run and retry it.
      if (composerEditorRef.current?.isEmpty() ?? true) {
        composerEditorRef.current?.setContent(prompt);
      }
      setError(messageFromError(err));
      dispatchAgentSessionStatus({
        prompt,
        title: titleFromPrompt(prompt),
        status: "failed",
        summary: messageFromError(err),
      });
    } finally {
      setSubmitting(false);
      setHeroLeaving(false);
    }
  }

  function runShortcut(shortcut: AgentShortcut) {
    if (shortcut.action === "run") {
      void launchShortcutSession(shortcut.prompt);
      return;
    }
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
    rememberComposerDraft(composerDraftKeyRef.current, shortcut.prompt, null);
  }

  async function cancelTask(taskId: string) {
    try {
      upsertTask(await cancelAgentTask(taskId));
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  // Stops a running June turn: interrupts the runtime session over the
  // gateway, then clears the local working/waiting flags regardless — the
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
    delete pendingSteerBySessionIdRef.current[sessionId];
    const activityCounts = clearSessionActivity(sessionId);
    // Feature 11: the per-session listener is gone, so no terminal frame will
    // reach the activity store to retire this row. Record a synthetic terminal
    // lifecycle so the drawer flips the session out of "running" the instant
    // the user clicks stop (the row persists, now reading as complete).
    hermesActivityStore.record(
      { kind: "lifecycle", sessionId, status: "cancelled" },
      hermesModeFor(sessionId),
    );
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
      setError(messageFromError(err), { sessionId });
    } finally {
      setFilesystemLoading(false);
    }
  }

  // Manual rename. Records an override (same channel the auto-suggested titles
  // use) and marks the session so the suggester won't clobber the user's name.
  // The sessions-changed effect propagates it to the sidebar.
  function renameHermesSession(sessionId: string, title: string) {
    titleSuggestionSessionIdsRef.current.add(sessionId);
    sessionTitleOverridesRef.current = {
      ...sessionTitleOverridesRef.current,
      [sessionId]: title,
    };
    setHermesSessionItems((current) =>
      current.map((item) => (item.id === sessionId ? { ...item, title } : item)),
    );
  }

  // Drops a deleted session from local state. Removing it from items fires
  // the sessions-changed effect, which syncs the sidebar; the shared scrub
  // clears messages, pending sends, working/waiting flags, and live events so
  // a running session doesn't linger as phantom "working" work.
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
    if (
      sessionTitleOverridesRef.current[sessionId] ||
      titleSuggestionSessionIdsRef.current.has(sessionId)
    ) {
      return;
    }
    const session = hermesSessionItems.find((item) => item.id === sessionId);
    if (!session || !isReplaceableAgentSessionTitle(session.title)) return;
    const firstUserMessage = messages.find((message) => message.role === "user");
    const prompt = firstUserMessage ? visibleHermesMessageText(firstUserMessage).trim() : "";
    if (!prompt) return;
    titleSuggestionSessionIdsRef.current.add(sessionId);
    const title = await agentSessionTitleForPrompt(prompt);
    sessionTitleOverridesRef.current = {
      ...sessionTitleOverridesRef.current,
      [sessionId]: title,
    };
    setHermesSessionItems((current) =>
      current.map((item) => (item.id === sessionId ? { ...item, title } : item)),
    );
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

  // Hoisted so the trailing "Thinking…" indicator only shows in the gap after a
  // send (last turn is the user's) — once an assistant turn exists it carries
  // its own thinking/streaming state, so we don't double up.
  const hermesTurns = selectedHermesSessionId
    ? // Merge the `/image` overlay (client-synthesized assistant image turns)
      // with the gateway-derived turns, ordered by createdAt. Array.sort is
      // stable, and an image turn's createdAt is minted strictly after its user
      // prompt, so the image always renders below the prompt that produced it.
      [
        ...mergeThinkingTurns(
          buildHermesSessionChatTurns(
            selectedHermesMessages,
            liveEvents[selectedHermesSessionId] ?? [],
          ),
        ),
        ...(imageTurnsBySession[selectedHermesSessionId] ?? []),
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
  const downloadArtifact = (artifact: AgentArtifact) =>
    void downloadHermesBridgeFile(artifact.path).catch((err: unknown) =>
      setError(messageFromError(err)),
    );
  const openArtifact = (artifact: AgentArtifact) => setArtifactPanel({ view: "file", artifact });

  // A `/image` result reuses the artifact view/download flow: download saves the
  // imported workspace file; "open" enlarges it in the same file viewer any
  // generated file uses. The image part carries its bytes inline for the
  // thumbnail, but the affordances key off the imported path on disk.
  const downloadGeneratedImage = (part: Extract<AgentChatPart, { type: "image" }>) => {
    if (!part.path) return;
    void downloadHermesBridgeFile(part.path).catch((err: unknown) =>
      setError(messageFromError(err)),
    );
  };
  const openGeneratedImage = (part: Extract<AgentChatPart, { type: "image" }>) => {
    if (!part.path) return;
    openArtifact({
      name: part.name?.trim() || "Generated image",
      path: part.path,
      rootLabel: "Workspace",
    });
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
        <AnimatePresence>
          {busyNotice || galleryErrors ? (
            // Same fade as the recording-consent note, so the pill dissolves
            // when the turn finishes instead of vanishing.
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
              {busyNotice ?? SESSION_BUSY_NOTICE}
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
          ) : visibleIssueReportNotice ? (
            <motion.p
              key="issue-report-notice"
              className="agent-composer-notice"
              role="status"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              {visibleIssueReportNotice}
            </motion.p>
          ) : visibleModelSwitchNotice ? (
            <motion.p
              key="model-switch-notice"
              className="agent-composer-notice"
              role="status"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              {visibleModelSwitchNotice}
            </motion.p>
          ) : null}
        </AnimatePresence>
        <div ref={composerBoxRef} className="agent-composer-box">
          {attachments.length ? (
            <div className="agent-composer-attachments">
              {attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="agent-attachment-chip"
                  data-attach-status={attachment.attach.status}
                  title={attachment.attach.error ?? attachment.name}
                >
                  {attachment.previewDataUrl ? (
                    <img src={attachment.previewDataUrl} alt="" aria-hidden="true" />
                  ) : (
                    <FileTypeIcon name={attachment.name} size={14} />
                  )}
                  <span className="agent-attachment-name">{attachment.name}</span>
                  {attachmentStatusLabel(attachment.attach) ? (
                    <span
                      className="agent-attachment-status"
                      data-attach-status={attachment.attach.status}
                    >
                      {attachmentStatusLabel(attachment.attach)}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    <IconCrossSmall size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {showImageInputWarning ? (
            <div className="agent-composer-image-warning" role="status">
              <IconExclamationTriangle
                size={14}
                aria-hidden
                className="agent-composer-image-warning-icon"
              />
              <span className="agent-composer-image-warning-text">
                {resolvedGenerationModel?.name ?? "This model"} can't read images.
              </span>
              {preferredVisionModel ? (
                <button
                  type="button"
                  className="agent-composer-notice-button agent-composer-image-warning-action"
                  onClick={() =>
                    // Switch straight to the preferred image-capable model. The
                    // label promises a one-tap fix, and the generic model picker
                    // isn't vision-scoped — opening it for the multi-candidate
                    // case would drop the user into an unfiltered list that
                    // doesn't surface the eligible models. preferredVisionModel
                    // is pre-filtered to image + tool support and prefers a
                    // suggested pick; handleSelectGenerationModel routes the
                    // global default vs per-chat override.
                    void handleSelectGenerationModel(preferredVisionModel.id)
                  }
                >
                  Switch to {preferredVisionModel.name}
                </button>
              ) : null}
            </div>
          ) : null}
          <ComposerEditor
            ref={composerEditorRef}
            skills={skills}
            placeholder={
              generatingImage
                ? "Generating image…"
                : importingFiles
                  ? "Attaching file…"
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
            onReady={() => {
              restoreComposerDraft(composerDraftKeyRef.current);
              seedComposerCategory({ defer: true });
            }}
          />
          <div className="agent-composer-toolbar">
            <button
              type="button"
              ref={attachTriggerRef}
              className="agent-composer-attach"
              aria-label="Attach files or tag this message"
              title="Attach or tag"
              aria-haspopup="menu"
              aria-expanded={attachMenuOpen}
              data-open={attachMenuOpen || undefined}
              onClick={() => setAttachMenuOpen((open) => !open)}
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
                title="Start dictation"
                onClick={() => void startDictation()}
              >
                <IconMicrophone size={18} />
              </button>
              {selectedHermesSessionId &&
              !selectedHermesSessionIsProvisional &&
              workingSessionIds.has(selectedHermesSessionId) ? (
                // While June works, stop owns the send slot — sending would
                // only bounce off the gateway's busy guard anyway.
                <button
                  type="button"
                  className="agent-composer-stop"
                  aria-label="Stop June"
                  title="Stop June"
                  disabled={stoppingSessionIds.has(selectedHermesSessionId)}
                  onClick={() => void stopHermesSession(selectedHermesSessionId)}
                >
                  <IconStop size={16} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="agent-composer-send"
                  disabled={
                    submitting ||
                    importingFiles ||
                    selectedHermesSessionIsProvisional ||
                    (!draft.trim() && !attachments.length)
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
            aria-label="Attach or tag this message"
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
            <div className="agent-attach-menu-divider" role="separator" />
            {REPORT_CATEGORIES.map((reportCategory) => (
              <button
                key={reportCategory.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAttachMenuOpen(false);
                  composerEditorRef.current?.insertCategory(reportCategory.key);
                  composerEditorRef.current?.focus();
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
        {composerModelOpen ? (
          <ComposerModelPopover
            flyout={composerModelFlyout}
            model={generationModel}
            options={modelOptions(generationModels, generationModel?.id ?? "")}
            search={modelSearch}
            popoverRef={composerModelPopoverRef}
            searchRef={composerModelSearchRef}
            onFlyoutChange={setComposerModelFlyout}
            onSearchChange={setModelSearch}
            onSelect={(modelId) => void handleSelectGenerationModel(modelId)}
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
                  <IconCheckmark1Small
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
          // `sanitizePayload`; there is no real reporting surface yet — see the
          // feature 15 notes). Logged in dev until that surface lands.
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
          onEditUserPrompt={editUserPrompt}
        />
      ))}
      {workingSessionIds.has(selectedHermesSessionId) && hermesTurns.at(-1)?.role === "user" ? (
        <AgentThinking />
      ) : null}
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
            onTopUp={handleTopUp}
            topUpLabel={topUpLabel}
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
            onEditUserPrompt={editUserPrompt}
          />
        ))}
        {workingTaskIds.has(selectedTask.id) && taskTurns.at(-1)?.role === "user" ? (
          <AgentThinking />
        ) : null}
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
              onRetry={
                GATEWAY_CONNECTION_ERROR.test(visibleError)
                  ? () => void retryGatewayConnection()
                  : undefined
              }
              onDismiss={() => setError(null)}
            />
          ) : null}
          <div className="agent-hero-heading">
            <h2 className="agent-hero-title">{heroGreeting}</h2>
          </div>
          {composer}
          {activePanel === "chat" ? (
            <div className="agent-hero-suggestions">
              <div
                className="agent-hero-chips"
                data-phase={heroChipPhase}
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
                  onRetry={
                    GATEWAY_CONNECTION_ERROR.test(visibleError)
                      ? () => void retryGatewayConnection()
                      : undefined
                  }
                  onDismiss={() => setError(null)}
                />
              ) : null}
              {branchedNotice && branchedNotice.sessionId === selectedHermesSessionId ? (
                <AgentBranchedBanner
                  sourceTitle={branchedNotice.sourceTitle}
                  onDismiss={() => setBranchedNotice(null)}
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
          {usagePanelSessionId
            ? createPortal(
                <div
                  className="agent-usage-overlay"
                  role="presentation"
                  onClick={(event) => {
                    if (event.target === event.currentTarget) {
                      setUsagePanelSessionId(null);
                    }
                  }}
                >
                  <SessionUsagePanel
                    sessionId={usagePanelSessionId}
                    fetchUsage={fetchSessionUsage}
                    onClose={() => setUsagePanelSessionId(null)}
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
    </section>
  );
}

function ComposerModelPicker({
  open,
  model,
  triggerRef,
  onToggleOpen,
}: {
  open: boolean;
  model?: VeniceModelDto;
  triggerRef: RefObject<HTMLButtonElement>;
  onToggleOpen: () => void;
}) {
  if (!model) return null;
  return (
    <div className="agent-composer-model" data-open={open || undefined}>
      <button
        ref={triggerRef}
        type="button"
        className="agent-composer-model-trigger"
        aria-label={`Model: ${model.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggleOpen}
      >
        <span>{model.name}</span>
        <IconChevronDownSmall size={12} aria-hidden />
      </button>
    </div>
  );
}

// The composer model popover is two-layered, menu-style: the root layer
// lists the curated suggested models as plain rows, and a flyout panel
// opens beside it — hover details for a suggested row, or the searchable
// full catalog behind the "All models" row.
type ComposerModelFlyout = { kind: "model"; id: string } | { kind: "all" } | null;

// Hover-intent delay before a hover opens a flyout or card — a pointer
// sweeping across rows (or rows scrolling under a resting pointer) should
// not flash panels open. Click and keyboard focus stay immediate.
const MODEL_HOVER_INTENT_MS = 150;
const MODEL_HOVERCARD_W = 220;
const MODEL_HOVERCARD_GAP = 4;
const MODEL_HOVERCARD_VIEWPORT_MARGIN = 12;

function ComposerModelPopover({
  flyout,
  model,
  options,
  search,
  popoverRef,
  searchRef,
  onFlyoutChange,
  onSearchChange,
  onSelect,
}: {
  flyout: ComposerModelFlyout;
  model?: VeniceModelDto;
  options: VeniceModelDto[];
  search: string;
  popoverRef: RefObject<HTMLDivElement>;
  searchRef: RefObject<HTMLInputElement>;
  onFlyoutChange: (flyout: ComposerModelFlyout) => void;
  onSearchChange: (value: string) => void;
  onSelect: (modelId: string) => void;
}) {
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Styled hover card for catalog rows (replaces the native title tooltip):
  // fixed-positioned next to the hovered row, on the panel's outer side.
  const [catalogHover, setCatalogHover] = useState<{
    model: VeniceModelDto;
    top: number;
    x: number;
    side: "left" | "right";
  } | null>(null);
  // One shared timer debounces every hover trigger in the popover.
  const hoverTimerRef = useRef<number | null>(null);
  const cancelHoverIntent = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);
  const hoverIntent = useCallback(
    (action: () => void) => {
      cancelHoverIntent();
      hoverTimerRef.current = window.setTimeout(action, MODEL_HOVER_INTENT_MS);
    },
    [cancelHoverIntent],
  );
  useEffect(() => cancelHoverIntent, [cancelHoverIntent]);
  // The catalog hover card is interactive (its description carries its own
  // hover tip for the full, untruncated text), so it cannot vanish the instant
  // the pointer leaves a row — it has to survive the trip across the gap onto
  // the card. A short close debounce bridges that gap; entering the card or a
  // fresh row cancels it.
  const closeTimerRef = useRef<number | null>(null);
  const cancelCatalogClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const scheduleCatalogClose = useCallback(() => {
    cancelCatalogClose();
    closeTimerRef.current = window.setTimeout(() => setCatalogHover(null), MODEL_HOVER_INTENT_MS);
  }, [cancelCatalogClose]);
  useEffect(() => cancelCatalogClose, [cancelCatalogClose]);
  // Position-aware scroll fades on the catalog list, same treatment as the
  // artifact panel body: only when it overflows, only on edges with hidden
  // content.
  const [fade, setFade] = useState({ top: false, bottom: false });
  const updateFade = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const canScroll = el.scrollHeight - el.clientHeight > 1;
    const atTop = el.scrollTop <= 1;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    setFade((prev) => {
      const top = canScroll && !atTop;
      const bottom = canScroll && !atBottom;
      return prev.top === top && prev.bottom === bottom ? prev : { top, bottom };
    });
  }, []);

  // The flyout always opens on the composer side (left of the menu), where
  // there is reliably room — flipping with the window edge made the card
  // jump sides between otherwise-identical hovers. The right side is only a
  // fallback for the degenerate case of the menu hugging the left edge.
  //
  // The hover detail card pins to the hovered row, submenu-style, so it
  // shows up next to the pointer. The all-models panel stays anchored to
  // the menu's bottom edge and grows upward, so its height is capped to the
  // room above — clearing the titlebar strip, which would otherwise cover
  // the search field — and to a fixed ceiling so it doesn't tower on tall
  // windows.
  useLayoutEffect(() => {
    const el = flyoutRef.current;
    if (!el) return;
    el.dataset.side = "left";
    if (flyout?.kind === "model") {
      const row = el.parentElement?.querySelector<HTMLElement>(
        '.agent-composer-model-row[data-active="true"]',
      );
      el.style.top = row ? `${row.offsetTop}px` : "";
      el.style.bottom = row ? "auto" : "";
      el.style.maxHeight = "";
    } else {
      el.style.top = "";
      el.style.bottom = "";
      const titlebar = parseFloat(getComputedStyle(el).getPropertyValue("--titlebar-h")) || 0;
      const room = el.getBoundingClientRect().bottom - titlebar - 16;
      el.style.maxHeight = `${Math.max(160, Math.min(room, 400))}px`;
    }
    if (el.getBoundingClientRect().left < 12) {
      el.dataset.side = "right";
    }
  }, [flyout]);

  // Re-measure the fades whenever the list's content or cap changes: panel
  // open (after the max-height effect above), and every search keystroke.
  useLayoutEffect(() => {
    updateFade();
  }, [flyout, search, options, updateFade]);

  // Row positions shift under the pointer on filter/reflow, so a lingering
  // card would point at the wrong row.
  useEffect(() => {
    setCatalogHover(null);
  }, [flyout, search]);

  if (!model) return null;
  const suggested = suggestedModelsForMode("generation", options);
  const query = search.trim().toLowerCase();
  // June's agent needs tool calls, so models without tool support can never
  // be picked — leave them out of the quick-switch list entirely instead of
  // showing dead rows. (Settings still lists them, greyed, for context.)
  const selectable = options.filter((option) => !option.provider || modelSupportsTools(option));
  const filteredOptions = query
    ? selectable.filter((option) => modelMatchesQuery(option, query))
    : selectable;
  const detail =
    flyout?.kind === "model" ? suggested.find((item) => item.model.id === flyout.id) : undefined;

  function showCatalogHover(option: VeniceModelDto, row: HTMLElement) {
    cancelCatalogClose();
    const panel = flyoutRef.current;
    if (!panel) return;
    const rowRect = row.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const preferred = panel.dataset.side === "right" ? "right" : "left";
    const canOpenLeft =
      panelRect.left - MODEL_HOVERCARD_GAP - MODEL_HOVERCARD_W - MODEL_HOVERCARD_VIEWPORT_MARGIN >=
      0;
    const canOpenRight =
      panelRect.right + MODEL_HOVERCARD_GAP + MODEL_HOVERCARD_W + MODEL_HOVERCARD_VIEWPORT_MARGIN <=
      window.innerWidth;
    const side =
      preferred === "left"
        ? canOpenLeft
          ? "left"
          : canOpenRight
            ? "right"
            : null
        : canOpenRight
          ? "right"
          : canOpenLeft
            ? "left"
            : null;
    if (!side) {
      setCatalogHover(null);
      return;
    }
    setCatalogHover({
      model: option,
      top: rowRect.top,
      x:
        side === "right"
          ? panelRect.right + MODEL_HOVERCARD_GAP
          : panelRect.left - MODEL_HOVERCARD_GAP,
      side,
    });
  }

  return (
    <div
      ref={popoverRef}
      className="agent-composer-model-popover"
      role="dialog"
      aria-label="Choose text model"
      onMouseLeave={() => {
        // Hover details follow the pointer out; the all-models panel stays
        // pinned so a search in progress doesn't vanish mid-keystroke.
        cancelHoverIntent();
        if (flyout?.kind === "model") onFlyoutChange(null);
      }}
    >
      <p className="agent-composer-model-title">Model</p>
      <div className="agent-composer-model-menu" role="listbox" aria-label="Suggested text models">
        {suggested.length ? (
          suggested.map(({ model: option }) => (
            <button
              key={option.id}
              type="button"
              className="agent-composer-model-row"
              role="option"
              aria-selected={option.id === model.id}
              data-active={(flyout?.kind === "model" && flyout.id === option.id) || undefined}
              onMouseEnter={() =>
                hoverIntent(() => onFlyoutChange({ kind: "model", id: option.id }))
              }
              onFocus={() => {
                cancelHoverIntent();
                onFlyoutChange({ kind: "model", id: option.id });
              }}
              onClick={() => onSelect(option.id)}
            >
              <span className="agent-composer-model-row-name">{option.name}</span>
              {option.id === model.id ? (
                <IconCheckmark1Small
                  size={14}
                  aria-hidden
                  className="agent-composer-model-row-check"
                />
              ) : null}
            </button>
          ))
        ) : (
          <p className="agent-composer-model-empty">Loading suggested models.</p>
        )}
      </div>
      <button
        type="button"
        className="agent-composer-model-row agent-composer-model-all"
        aria-haspopup="true"
        aria-expanded={flyout?.kind === "all"}
        data-active={flyout?.kind === "all" || undefined}
        onMouseEnter={() => hoverIntent(() => onFlyoutChange({ kind: "all" }))}
        onFocus={() => {
          cancelHoverIntent();
          onFlyoutChange({ kind: "all" });
        }}
        onClick={() => {
          cancelHoverIntent();
          onFlyoutChange({ kind: "all" });
          searchRef.current?.focus();
        }}
      >
        <span className="agent-composer-model-row-name">All models</span>
        <IconChevronRightSmall size={12} aria-hidden className="agent-composer-model-row-chevron" />
      </button>
      {detail ? (
        <div ref={flyoutRef} className="agent-composer-model-flyout agent-composer-model-detail">
          <div className="agent-composer-model-surface">
            <ComposerModelCardContent model={detail.model} />
          </div>
        </div>
      ) : flyout?.kind === "all" ? (
        <div
          ref={flyoutRef}
          className="agent-composer-model-flyout agent-composer-model-all-panel"
          role="group"
          aria-label="All text models"
          onMouseLeave={() => {
            cancelHoverIntent();
            scheduleCatalogClose();
          }}
        >
          <div className="agent-composer-model-surface">
            <label className="agent-composer-model-search">
              <IconMagnifyingGlass size={14} aria-hidden />
              <input
                ref={searchRef}
                value={search}
                onChange={(event) => onSearchChange(event.currentTarget.value)}
                placeholder="Search models"
                aria-label="Search models"
              />
            </label>
            <div
              className="agent-composer-model-list-wrap"
              data-fade-top={fade.top || undefined}
              data-fade-bottom={fade.bottom || undefined}
            >
              <div
                ref={listRef}
                className="agent-composer-model-list"
                role="listbox"
                aria-label="All text models"
                onScroll={() => {
                  updateFade();
                  cancelHoverIntent();
                  setCatalogHover(null);
                }}
              >
                {filteredOptions.length ? (
                  filteredOptions.map((option) => (
                    <ComposerModelOption
                      key={option.id}
                      model={option}
                      selected={option.id === model.id}
                      onSelect={onSelect}
                      onHover={(hoverModel, row, immediate) => {
                        cancelCatalogClose();
                        if (immediate) {
                          cancelHoverIntent();
                          showCatalogHover(hoverModel, row);
                        } else {
                          hoverIntent(() => showCatalogHover(hoverModel, row));
                        }
                      }}
                    />
                  ))
                ) : (
                  <p className="agent-composer-model-empty">No models match your search.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {flyout?.kind === "all" && catalogHover ? (
        <div
          className="agent-composer-model-hovercard agent-composer-model-detail"
          data-side={catalogHover.side}
          onMouseEnter={cancelCatalogClose}
          onMouseLeave={scheduleCatalogClose}
          style={
            catalogHover.side === "right"
              ? { top: catalogHover.top, left: catalogHover.x }
              : {
                  top: catalogHover.top,
                  right: window.innerWidth - catalogHover.x,
                }
          }
        >
          <div className="agent-composer-model-surface">
            <ComposerModelCardContent model={catalogHover.model} withDescription />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Footnote under the hero composer. June's agent runs on the user's Mac, but
// model calls go out to the provider, so the privacy claim has to match the
// active model: encrypted into the enclave (E2EE), private (zero retention),
// or anonymized (identity stripped, prompts may be retained). Name the model
// so it's clear what's running; fall back to the plain line when none is known.
function heroPrivacyFootnote(
  model: VeniceModelDto | undefined,
  badge: ModelPrivacyBadge | undefined,
): string {
  if (!model) return "June runs locally.";
  switch (badge?.mode) {
    case "e2ee":
      return `June runs locally. Calls to ${model.name} are end-to-end encrypted.`;
    case "private":
      return `June runs locally. Calls to ${model.name} are private.`;
    case "anonymous":
      return `June runs locally. Calls to ${model.name} are anonymized.`;
    default:
      return `June runs locally. You're running ${model.name}.`;
  }
}

// Shared content of the model hover cards: name with the privacy chip
// alongside, then the value line (pricing, context window). The catalog
// card also carries the model's description, standing in for the native
// title tooltip it replaces.
function ComposerModelCardContent({
  model,
  withDescription,
}: {
  model: VeniceModelDto;
  withDescription?: boolean;
}) {
  const badge = modelPrivacyBadge(model);
  const values = [pricingLabel(model), contextLabel(model)].filter(Boolean).join(" · ");
  return (
    <>
      <p className="agent-composer-model-detail-name">
        <span>{model.name}</span>
        {badge ? (
          <span className="model-trait-icon" data-mode={badge.mode} title={badge.description}>
            {badge.mode === "e2ee" ? (
              <IconLock size={14} aria-hidden />
            ) : badge.mode === "private" ? (
              <IconGhost2 size={14} aria-hidden />
            ) : (
              <IconAnonymous size={14} aria-hidden />
            )}
            <span>{badge.label.replace(" mode", "")}</span>
          </span>
        ) : null}
      </p>
      {values ? <p className="agent-composer-model-detail-values">{values}</p> : null}
      {withDescription && model.description ? (
        <ComposerModelDescription text={model.description} />
      ) : null}
    </>
  );
}

// The catalog card clamps the description to two lines so it stays compact.
// When that clamp actually hides text, the row becomes its own hover tip
// carrying the full copy — hover the truncated blurb to read the rest. The tip
// only attaches when the text is clipped, so short descriptions don't get a
// redundant repeat of what's already fully visible.
function ComposerModelDescription({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setClamped(el.scrollHeight - el.clientHeight > 1);
  }, [text]);
  const body = (
    <span ref={ref} className="agent-composer-model-detail-desc">
      {text}
    </span>
  );
  return clamped ? (
    <HoverTip tip={text} className="agent-composer-model-detail-desc-tip">
      {body}
    </HoverTip>
  ) : (
    body
  );
}

// Name-only rows: the composer popover is for quick switching, so pricing,
// context, and privacy detail live in the hover card beside the row.
function ComposerModelOption({
  model,
  selected,
  onSelect,
  onHover,
}: {
  model: VeniceModelDto;
  selected: boolean;
  onSelect: (modelId: string) => void;
  onHover: (model: VeniceModelDto, row: HTMLElement, immediate: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="agent-composer-model-row"
      role="option"
      aria-selected={selected}
      onMouseEnter={(event) => onHover(model, event.currentTarget, false)}
      onFocus={(event) => onHover(model, event.currentTarget, true)}
      onClick={() => onSelect(model.id)}
    >
      <span className="agent-composer-model-row-name">{model.name}</span>
      {selected ? (
        <IconCheckmark1Small size={14} aria-hidden className="agent-composer-model-row-check" />
      ) : null}
    </button>
  );
}

function modelMatchesQuery(model: VeniceModelDto, query: string) {
  return [model.name, model.id, model.description, model.privacy, ...model.traits]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

// The current model's privacy mode as a pill — Private, Anonymous, or E2EE,
// with the same icons the composer model popover uses. The model itself is
// switched from the composer's picker; this badge just keeps the privacy
// claim visible while the conversation scrolls. The claims stay verifiable:
// the attestation walkthrough lives in Settings (Models and About) and
// onboarding.
function PrivacyModeBadge({ badge }: { badge?: ModelPrivacyBadge }) {
  if (!badge) return null;
  return (
    <HoverTip
      tip={badge.description}
      className="agent-safety-badge"
      data-mode={badge.mode}
      tabIndex={0}
      aria-label={`${badge.label} - ${badge.description}`}
    >
      {badge.mode === "e2ee" ? (
        <IconLock size={13} aria-hidden />
      ) : badge.mode === "private" ? (
        <IconGhost2 size={13} aria-hidden />
      ) : (
        <IconAnonymous size={13} aria-hidden />
      )}
      {badge.label}
    </HoverTip>
  );
}

// Indicator of the selected session's opt-in. The jail itself is
// per-process, but every send restarts the runtime into the target session's
// recorded mode, so the session — not the runtime's current state — is the
// honest unit to label.
function UnrestrictedBadge() {
  const description =
    "This session runs without the file sandbox: June can change any file your account can. Sandboxed sessions keep their jail and run alongside on a separate, jailed runtime.";
  return (
    <HoverTip
      tip={description}
      className="agent-safety-badge agent-sandbox-badge"
      tabIndex={0}
      aria-label={`Unrestricted - ${description}`}
    >
      <IconShieldCrossed size={13} aria-hidden />
      Unrestricted
    </HoverTip>
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
  onToggleArtifacts,
  onRename,
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
  onToggleArtifacts?: () => void;
  onRename?: (title: string) => void;
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
    const next = draft.trim();
    if (onRename && next && next !== title) onRename(next);
  }

  const hasMenu = Boolean(
    onRename || onDelete || onShowUsage || onCompactContext || onOpenTuiDebug,
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

async function agentSessionTitleForPrompt(prompt: string) {
  try {
    const response = await withTimeout(suggestAgentSessionTitle(prompt), AGENT_TITLE_TIMEOUT_MS);
    return response.title.trim() || titleFromPrompt(prompt);
  } catch {
    return titleFromPrompt(prompt);
  }
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
  onToggle: (platform: HermesMessagingPlatformInfo, enabled: boolean) => void;
}) {
  const q = query.trim().toLowerCase();
  const visible = (platforms ?? [])
    .filter((platform) => capabilityMatches(platform, q))
    .sort((a, b) => safeText(a.name).localeCompare(safeText(b.name)));
  const selected =
    visible.find((platform) => platform.id === selectedPlatformId) ?? visible[0] ?? null;
  return (
    <section className="agent-management-panel" aria-label="Messaging">
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
        <div className="agent-messaging-layout">
          <div className="agent-messaging-list" aria-label="Messaging channels">
            <CapabilityGroup title="Messaging" count={visible.length} empty="No matching platforms">
              {visible.map((platform) => {
                const envVars = platform.envVars ?? platform.env_vars ?? [];
                const requiredSet = envVars.filter(
                  (field) => field.required && envFieldSet(field),
                ).length;
                const requiredTotal = envVars.filter((field) => field.required).length;
                const state = platform.state ?? "unknown";
                const configured =
                  platform.configured || (requiredTotal > 0 && requiredSet === requiredTotal);
                return (
                  <CapabilityRow
                    key={platform.id}
                    title={platform.name}
                    description={platform.description}
                    meta={`${stateLabel(state)}${
                      requiredTotal
                        ? ` · ${requiredSet}/${requiredTotal} required set`
                        : configured
                          ? " · configured"
                          : ""
                    }`}
                    enabled={Boolean(platform.enabled)}
                    selected={platform.id === selected?.id}
                    saving={saving === `messaging:${platform.id}`}
                    onSelect={() => onSelectPlatform(platform)}
                    onToggle={(enabled) => onToggle(platform, enabled)}
                  />
                );
              })}
            </CapabilityGroup>
          </div>
          <MessagingPlatformDetail
            envEdits={envEdits}
            platform={selected}
            saving={saving}
            onEditEnv={onEditEnv}
            onSaveEnv={onSaveEnv}
            onToggle={onToggle}
          />
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
                  <h3 className="agent-files-root-title">
                    <IconBubble3 size={14} />
                    {root.label}
                  </h3>
                  <p>{root.description}</p>
                </div>
                <code>{compactPath(root.path)}</code>
              </header>
              {root.entries.length ? (
                <div className="agent-files-tree">
                  {root.entries.map((entry) => (
                    <FilesystemEntryRow key={entry.path} entry={entry} level={0} />
                  ))}
                </div>
              ) : (
                <p className="agent-capability-empty">No visible entries</p>
              )}
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

function MessagingPlatformDetail({
  envEdits,
  platform,
  saving,
  onEditEnv,
  onSaveEnv,
  onToggle,
}: {
  envEdits: Record<string, string>;
  platform: HermesMessagingPlatformInfo | null;
  saving: string | null;
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
          <div className="agent-platform-avatar" aria-hidden="true">
            {platform.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h3>{platform.name}</h3>
            <p>{platform.description}</p>
            <div className="agent-platform-pills">
              <span>{stateLabel(platform.state ?? "unknown")}</span>
              <span>{platform.configured ? "Credentials set" : "Needs setup"}</span>
              {platform.gatewayRunning || platform.gateway_running ? null : (
                <span>Messaging gateway stopped</span>
              )}
            </div>
          </div>
        </header>
        {platform.errorMessage || platform.error_message ? (
          <div className="agent-platform-error">
            {platform.errorMessage ?? platform.error_message}
          </div>
        ) : null}
        {docsUrl ? (
          <a className="agent-platform-docs" href={docsUrl} rel="noreferrer" target="_blank">
            Open setup guide
          </a>
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
              onClick={() => setShowAdvanced((value) => !value)}
            >
              Advanced ({advanced.length})
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
    </div>
  );
}

function MessagingFieldGroup({
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
  return (
    <div className="agent-management-toolbar">
      <input
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        placeholder={placeholder}
      />
      <button type="button" disabled={loading} onClick={onRefresh}>
        <IconArrowRotateClockwise size={14} />
        Refresh
      </button>
    </div>
  );
}

function CapabilityGroup({
  children,
  count,
  empty,
  title,
}: {
  children: ReactNode;
  count: number;
  empty: string;
  title: string;
}) {
  return (
    <section className="agent-capability-group">
      <h3>
        {title} <span>{count}</span>
      </h3>
      {count ? children : <p className="agent-capability-empty">{empty}</p>}
    </section>
  );
}

function CapabilityRow({
  children,
  description,
  enabled,
  meta,
  saving,
  selected = false,
  title,
  onSelect,
  onToggle,
}: {
  children?: ReactNode;
  description?: string;
  enabled: boolean;
  meta?: string;
  saving: boolean;
  selected?: boolean;
  title: string;
  onSelect?: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <article className="agent-capability-row" data-selected={selected}>
      <button type="button" disabled={!onSelect} onClick={onSelect}>
        <div className="agent-capability-title">
          <span>{title}</span>
          {meta ? <em>{meta}</em> : null}
        </div>
        {description ? <p>{description}</p> : null}
        {children}
      </button>
      <button
        type="button"
        className="agent-switch"
        aria-pressed={enabled}
        disabled={saving}
        onClick={() => onToggle(!enabled)}
      >
        <span />
      </button>
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

const AGENT_TRANSCRIPT_BOTTOM_THRESHOLD_PX = 48;

function isAgentTranscriptNearBottom(scroller: HTMLElement) {
  return (
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
    AGENT_TRANSCRIPT_BOTTOM_THRESHOLD_PX
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

function AgentResponseGallery({
  sections,
  errors,
  onClose,
}: {
  sections: AgentChatGallerySection[];
  errors?: boolean;
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
  onThinkingOpenChange,
  onTopUp,
  topUpLabel,
  onBranch,
  onEditUserPrompt,
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
  onThinkingOpenChange: (key: string, open: boolean) => void;
  onTopUp?: () => void;
  topUpLabel?: string;
  onEditUserPrompt?: (text: string) => void;
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
  const copyText = copyableTextForTurn(turn);
  const userPromptText = turn.role === "user" ? copyText : "";

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
  // (which pass `onBranch`); it self-disables when the turn id is not a
  // persisted message id (see isBranchableMessageId).
  const branchSessionId = branchSourceSessionIdForTurn(turn);
  const branchAction = onBranch ? (
    <BranchFromHereAction
      messageId={turn.id}
      sessionId={branchSessionId}
      onBranch={onBranch}
      submitting={branchingMessageId === turn.id}
    />
  ) : null;
  const copyAction = copyText ? (
    <button
      type="button"
      className="agent-turn-action"
      aria-label={copied ? "Copied message" : "Copy message"}
      title={copied ? "Copied" : "Copy message"}
      data-copied={copied ? "true" : undefined}
      onClick={() => void copyTurn()}
    >
      {copied ? (
        <IconCheckmark1Small size={13} aria-hidden />
      ) : (
        <IconClipboard size={13} aria-hidden />
      )}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  ) : null;
  const editAction =
    turn.role === "user" && !turn.isScheduledRun && userPromptText && onEditUserPrompt ? (
      <button
        type="button"
        className="agent-turn-action"
        aria-label="Edit message"
        title="Edit message"
        onClick={() => onEditUserPrompt(userPromptText)}
      >
        <IconPencilLine size={13} aria-hidden />
        <span>Edit</span>
      </button>
    ) : null;
  const turnActions =
    copyAction || editAction || branchAction ? (
      <div className="agent-turn-actions">
        <div className="agent-turn-actions-inner">
          {copyAction}
          {editAction}
          {branchAction}
        </div>
      </div>
    ) : null;

  if (contextParts.length && turn.parts.every((part) => part.type === "context")) {
    return (
      <>
        {contextParts.map((part, index) => (
          <ContextCompactionPart
            key={`${turn.id}:context:${index}`}
            createdAt={turn.createdAt}
            part={part}
          />
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
            <ContextCompactionPart
              key={`${turn.id}:context:${index}`}
              createdAt={turn.createdAt}
              part={part}
            />
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
              />
            )
          ) : part.type === "steering" ? (
            <SteeringPart
              key={`${turn.id}:steering:${index}`}
              createdAt={turn.createdAt}
              part={part}
            />
          ) : part.type === "image" ? (
            <AgentGeneratedImage
              key={`${turn.id}:image:${index}`}
              part={part}
              onOpen={onOpenImage}
              onDownload={onDownloadImage}
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
            <span className="text-shimmer">Thinking…</span>
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

function ContextCompactionPart({
  createdAt,
  part,
}: {
  createdAt: string;
  part: Extract<AgentChatPart, { type: "context" }>;
}) {
  return (
    <details className="agent-context-summary">
      <summary>
        {/* Same hover affordance as the tool rows: the glyph cross-fades to a
         * plain-text "+"/"−" so the row reads as one quiet, expandable line.
         * IconConcise (thinned via CSS) marks the squeeze of compaction. */}
        <span className="agent-tool-icon">
          <IconConcise size={15} className="agent-context-icon-glyph" />
          <span className="agent-tool-icon-expand">+</span>
          <span className="agent-tool-icon-minimize">−</span>
        </span>
        <span className="agent-context-label">Context compacted</span>
        <time>{relativeDate(createdAt)}</time>
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
  onRetry,
}: {
  message: string;
  onDismiss: () => void;
  onRetry?: () => void;
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
        <button type="button" aria-label="Dismiss" onClick={onDismiss}>
          <IconCrossMedium size={14} />
        </button>
      </div>
    </div>
  );
}

// Feature 07: confirms the freshly-opened session was forked from another, so
// the user understands why they're suddenly in a new (but pre-populated)
// thread. role="status" (not "alert") — this is reassurance, not an error.
function AgentBranchedBanner({
  sourceTitle,
  onDismiss,
}: {
  sourceTitle: string;
  onDismiss: () => void;
}) {
  return (
    <div className="agent-branched-banner" role="status">
      <IconBranchSimple size={14} aria-hidden />
      <p>Branched from {sourceTitle}</p>
      <button type="button" aria-label="Dismiss" onClick={onDismiss}>
        <IconCrossMedium size={14} />
      </button>
    </div>
  );
}

function visibleAgentWorkspaceError(
  error: AgentWorkspaceError | null,
  selectedSessionId: string | undefined,
) {
  if (!error) return null;
  if (!error.sessionId) return selectedSessionId ? null : error.message;
  return error.sessionId === selectedSessionId ? error.message : null;
}

// The raw billing failure ("Error: Error code: 402 - …") never reaches the
// transcript — the chat runtime folds it into a notice part, and this card is
// how the user learns the turn stopped and what to do about it. No title —
// icon + one sentence + the action, Claude-style.
function CreditsNoticePart({
  onTopUp,
  topUpLabel = "Upgrade",
}: {
  onTopUp?: () => void;
  topUpLabel?: string;
}) {
  return (
    <InlineNotice
      className="agent-credits-notice"
      tone="destructive"
      role="alert"
      icon={<IconWallet3 size={14} aria-hidden />}
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
function SteeringPart({
  createdAt,
  part,
}: {
  createdAt: string;
  part: Extract<AgentChatPart, { type: "steering" }>;
}) {
  return (
    <div className="agent-steering-item">
      <span className="agent-steering-icon" aria-hidden>
        <IconArrowCornerDownRight size={14} />
      </span>
      <span className="agent-steering-label">Steering</span>
      <span className="agent-steering-text">{part.text}</span>
      <time>{relativeDate(createdAt)}</time>
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
}: {
  part: Extract<AgentChatPart, { type: "image" }>;
  onOpen?: (part: Extract<AgentChatPart, { type: "image" }>) => void;
  onDownload?: (part: Extract<AgentChatPart, { type: "image" }>) => void;
}) {
  if (part.status === "running") {
    return (
      <div className="agent-generated-image" data-status="running" role="status" aria-live="polite">
        <div className="agent-generated-image-placeholder">
          <span className="text-shimmer">Generating image…</span>
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
      </div>
    );
  }
  const label = part.name?.trim() || "Generated image";
  return (
    <figure className="agent-generated-image" data-status="complete">
      <button
        type="button"
        className="agent-generated-image-frame"
        onClick={() => onOpen?.(part)}
        aria-label={`Open ${label}`}
        title="Open image"
      >
        {part.dataUrl ? <img src={part.dataUrl} alt={part.prompt} draggable={false} /> : null}
      </button>
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

function ClarifyPart({
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

  return (
    <article className="agent-clarify-card" data-status={part.status}>
      <span className="agent-tool-icon">
        <IconBubbleWide size={14} />
      </span>
      <div>
        <div className="agent-tool-title">
          <span>Clarify</span>
          <span
            className="agent-tool-live-status"
            data-status={part.status === "pending" ? "running" : "complete"}
          >
            {part.status === "pending" ? "Waiting" : "Answered"}
          </span>
        </div>
        <p>{part.question}</p>
        {part.answer !== undefined ? (
          <p className="agent-clarify-answer">{part.answer.trim() ? part.answer : "Skipped"}</p>
        ) : null}
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
function AgentCliAccessCard({ cliAccess }: { cliAccess?: AgentCliAccessCardProps }) {
  const [dismissed, setDismissed] = useState(false);
  const enabled = cliAccess?.enabled === true;
  const resolved = enabled || dismissed;
  const busy = Boolean(cliAccess?.submitting);
  return (
    <article className="agent-approval-card" data-status={resolved ? "resolved" : "pending"}>
      <span className="agent-tool-icon">
        <IconConsole size={14} />
      </span>
      <div>
        <div className="agent-tool-title">
          <span>Agent CLI access requested</span>
          <span className="agent-tool-live-status" data-status={resolved ? "complete" : "running"}>
            {resolved ? "Resolved" : "Waiting"}
          </span>
        </div>
        <p>
          June wants write access to the state folders of your coding CLIs (Claude Code, Codex,
          Gemini, opencode) so they stay logged in and can save their work in sandboxed sessions.
          Those folders configure software that also runs outside June's sandbox. Enabling turns on
          "Agent CLI access" in Settings and restarts the sandboxed runtime.
        </p>
        {resolved ? (
          <p className="agent-approval-result" data-choice={enabled ? "once" : "deny"}>
            {enabled ? <IconCheckmark1Small size={14} /> : <IconCrossMedium size={14} />}
            {enabled ? "Agent CLI access enabled" : "Not now"}
          </p>
        ) : (
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
        )}
      </div>
    </article>
  );
}

function ApprovalPart({
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
  const resolved = part.status !== "pending" || activeChoice !== undefined;
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

  return (
    <article className="agent-approval-card" data-status={part.status}>
      <span className="agent-tool-icon">
        <IconShieldCheck size={14} />
      </span>
      <div>
        <div className="agent-tool-title">
          <span>Approval required</span>
          <span
            className="agent-tool-live-status"
            data-status={part.status === "pending" ? "running" : "complete"}
          >
            {part.status === "pending" ? "Waiting" : "Resolved"}
          </span>
        </div>
        <p>{part.description}</p>
        {part.command ? <pre>{part.command}</pre> : null}
        {!resolved && explainOpen ? (
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
        {resolved ? (
          <p className="agent-approval-result" data-choice={activeChoice}>
            {activeChoice === "deny" ? (
              <IconCrossMedium size={14} />
            ) : (
              <IconCheckmark1Small size={14} />
            )}
            {approvalChoiceLabel(
              activeChoice,
              part.status === "pending" && submitting !== undefined,
            )}
          </p>
        ) : (
          // System buttons (.btn) — quiet soft-fill choices, ghost deny. The
          // repeated per-button icons read as noise, so labels stand alone.
          <div className="agent-approval-actions">
            <button
              type="button"
              className="btn btn-secondary agent-approval-explain"
              aria-expanded={explainOpen}
              aria-controls={explanationId}
              disabled={disabled}
              onClick={toggleExplain}
            >
              <IconCircleQuestionmark size={14} />
              {explainOpen ? "Hide explanation" : "Explain first"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={disabled}
              onClick={() => onApproval(part, "once")}
            >
              Approve once
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={disabled}
              onClick={() => onApproval(part, "session")}
            >
              This session
            </button>
            {part.allowPermanent ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={disabled}
                onClick={() => onApproval(part, "always")}
              >
                Always
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost agent-approval-deny"
              disabled={disabled}
              onClick={() => onApproval(part, "deny")}
            >
              Deny
            </button>
          </div>
        )}
      </div>
    </article>
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

/** The per-message "Branch from here" action (feature 07). Forks the
 * conversation into a NEW session that starts from this message, leaving the
 * source session untouched. Message-level branching is honest only when the
 * turn is backed by a persisted Hermes message id; for in-flight/synthetic
 * turns the button is disabled and explains that the fork point is available
 * once the message is saved (see {@link isBranchableMessageId}). The branch
 * itself flows through the typed `branchSession` method via `onBranch`. */
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
  const branchable = isBranchableMessageId(messageId);
  const disabled = submitting || !branchable;
  return (
    <button
      type="button"
      className="agent-turn-action"
      // The disabled reason is honest, not silent: a synthetic/in-flight turn
      // has no persisted id Hermes can fork from yet.
      title={branchable ? "Branch from here" : "Branching is available once the message is saved"}
      aria-label="Branch from here"
      disabled={disabled}
      onClick={() => onBranch(messageId, sessionId)}
    >
      <IconBranchSimple size={13} aria-hidden />
      <span>Branch from here</span>
    </button>
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
  const resolved = part.status !== "pending" || submitting !== undefined;
  // Absent mode defaults to the safe direction (sandboxed) so the card never
  // implies more access than is being granted.
  const mode: HermesMode = part.mode ?? "sandboxed";
  const unrestricted = mode === "unrestricted";
  const decided = part.approved ?? (submitting ? submitting === "approve" : undefined);

  return (
    <article className="agent-approval-card" data-status={part.status}>
      <span className="agent-tool-icon">
        {unrestricted ? <IconShieldCrossed size={14} /> : <IconShieldCheck size={14} />}
      </span>
      <div>
        <div className="agent-tool-title">
          <span>Privilege escalation requested</span>
          <span
            className="agent-tool-live-status"
            data-status={part.status === "pending" ? "running" : "complete"}
          >
            {part.status === "pending" ? "Waiting" : "Resolved"}
          </span>
        </div>
        <p>{part.reason ?? "June needs elevated permissions before it can continue."}</p>
        {part.command ? <pre>{part.command}</pre> : null}
        <p
          className="agent-sudo-mode"
          data-mode={mode}
          title={
            unrestricted
              ? "Runs with full write access, outside June's sandbox."
              : "Runs inside June's write sandbox."
          }
        >
          {unrestricted ? (
            <IconShieldCrossed size={12} aria-hidden />
          ) : (
            <IconShieldCheck size={12} aria-hidden />
          )}
          {unrestricted
            ? "Will run unrestricted (full write access)"
            : "Will run sandboxed (limited write access)"}
        </p>
        {resolved ? (
          <p className="agent-approval-result" data-choice={decided ? "once" : "deny"}>
            {decided ? <IconCheckmark1Small size={14} /> : <IconCrossMedium size={14} />}
            {decided ? (submitting ? "Approving" : "Approved") : submitting ? "Denying" : "Denied"}
          </p>
        ) : (
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
        )}
      </div>
    </article>
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

  return (
    <article className="agent-approval-card" data-status={part.status}>
      <span className="agent-tool-icon">
        <IconLock size={14} />
      </span>
      <div>
        <div className="agent-tool-title">
          <span>Secret requested</span>
          <span
            className="agent-tool-live-status"
            data-status={part.status === "pending" ? "running" : "complete"}
          >
            {part.status === "pending" ? "Waiting" : "Provided"}
          </span>
        </div>
        <p>{part.reason ?? "June needs a secret value before it can continue."}</p>
        {label ? (
          <p className="agent-secret-key">
            <span>Key</span>
            <code>{label}</code>
          </p>
        ) : null}
        {part.status === "pending" ? (
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
              className="agent-secret-input"
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
        ) : (
          <p className="agent-approval-result" data-choice="once">
            <IconCheckmark1Small size={14} />
            Secret provided
          </p>
        )}
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
      <summary>
        <span className={running ? "text-shimmer" : undefined}>
          {running ? "Thinking" : "Thought"}
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
  const [fade, setFade] = useState({ top: false, bottom: false });
  const updateFade = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const canScroll = el.scrollHeight - el.clientHeight > 1;
    const atTop = el.scrollTop <= 1;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    setFade({ top: canScroll && !atTop, bottom: canScroll && !atBottom });
  }, []);
  useEffect(() => {
    const id = requestAnimationFrame(updateFade);
    const el = bodyRef.current;
    if (el && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateFade);
      observer.observe(el);
      return () => {
        cancelAnimationFrame(id);
        observer.disconnect();
      };
    }
    return () => cancelAnimationFrame(id);
  }, [updateFade, preview, state.view]);

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
            className="agent-artifact-panel-body"
            data-kind={preview.kind}
            data-fade-top={fade.top || undefined}
            data-fade-bottom={fade.bottom || undefined}
            onScroll={updateFade}
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
              className="agent-artifact-panel-body"
              data-kind="list"
              data-fade-top={fade.top || undefined}
              data-fade-bottom={fade.bottom || undefined}
              onScroll={updateFade}
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

function MarkdownContent({
  markdown,
  highlight,
  // Repairs the gateway's dropped-space-after-contraction artifact ("it'snot"
  // -> "it's not"). Only set for assistant prose: it must never touch code or
  // a user's own text. See repairContractionSpacing.
  repairProse = false,
}: {
  markdown: string;
  highlight?: string;
  repairProse?: boolean;
}) {
  return (
    <div className="agent-markdown">{renderMarkdownBlocks(markdown, highlight, repairProse)}</div>
  );
}

/** Wraps case-insensitive matches of `highlight` in <mark>, leaving the text
 * untouched when there's nothing to find. Every text emission point in the
 * markdown renderer funnels through here so find-in-file can light up
 * rendered documents, not just raw source. */
function highlightText(text: string, highlight: string | undefined, keySeed: string): ReactNode[] {
  const needle = highlight?.toLowerCase();
  if (!needle) return [text];
  const lower = text.toLowerCase();
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let count = 0;
  for (;;) {
    const at = lower.indexOf(needle, cursor);
    if (at < 0) break;
    if (at > cursor) nodes.push(text.slice(cursor, at));
    nodes.push(<mark key={`hl-${keySeed}-${count++}`}>{text.slice(at, at + needle.length)}</mark>);
    cursor = at + needle.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderMarkdownBlocks(markdown: string, highlight?: string, repairProse = false) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (!text) return;
    blocks.push(
      <p key={`p-${key++}`}>{renderInlineMarkdown(text, key, highlight, repairProse)}</p>,
    );
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      // Skip empty fences — including a stray trailing ``` while streaming —
      // so we don't flash an empty code block (a bare padded gray bar).
      const body = code.join("\n");
      if (body.trim()) {
        blocks.push(
          <pre key={`code-${key++}`}>
            <code>{highlightText(body, highlight, `code-${key}`)}</code>
          </pre>,
        );
      }
      continue;
    }

    // Thematic break (---, ***, ___) → a quiet rule instead of literal dashes.
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flushParagraph();
      blocks.push(<hr key={`hr-${key++}`} className="agent-md-rule" />);
      continue;
    }

    // Blockquote: strip the > prefix and re-render the inner lines, so quotes
    // can hold paragraphs, lists, or code like any other block.
    if (trimmed.startsWith(">")) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoted.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <blockquote key={`quote-${key++}`}>
          {renderMarkdownBlocks(quoted.join("\n"), highlight, repairProse)}
        </blockquote>,
      );
      continue;
    }

    // Pipe table: a |…| row followed by a |---|---| separator.
    const isTableRow = (value: string) =>
      value.startsWith("|") && value.endsWith("|") && value.length > 1;
    if (
      isTableRow(trimmed) &&
      index + 1 < lines.length &&
      /^\|(\s*:?-+:?\s*\|)+$/.test(lines[index + 1].trim())
    ) {
      flushParagraph();
      const splitRow = (value: string) =>
        value
          .slice(1, -1)
          .split("|")
          .map((cell) => cell.trim());
      const header = splitRow(trimmed);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index].trim())) {
        rows.push(splitRow(lines[index].trim()));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <div key={`table-${key++}`} className="agent-md-table">
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={cellIndex}>{renderInlineMarkdown(cell, key, highlight, repairProse)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>
                      {renderInlineMarkdown(cell, key, highlight, repairProse)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length, 3);
      const content = renderInlineMarkdown(heading[2], key, highlight, repairProse);
      blocks.push(
        level === 1 ? <h2 key={`h-${key++}`}>{content}</h2> : <h3 key={`h-${key++}`}>{content}</h3>,
      );
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index].trim();
        const match = orderedList
          ? /^\d+\.\s+(.+)$/.exec(candidate)
          : /^[-*]\s+(.+)$/.exec(candidate);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      index -= 1;
      const listItems = items.map((item, itemIndex) => (
        <li key={`li-${key}-${itemIndex}`}>
          {renderInlineMarkdown(item, key + itemIndex, highlight, repairProse)}
        </li>
      ));
      blocks.push(
        orderedList ? (
          <ol key={`list-${key++}`}>{listItems}</ol>
        ) : (
          <ul key={`list-${key++}`}>{listItems}</ul>
        ),
      );
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

function renderInlineMarkdown(
  text: string,
  keySeed: number,
  highlight?: string,
  repairProse = false,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const mark = (value: string, slot: string) =>
    highlightText(value, highlight, `${keySeed}-${slot}`);
  // Prose runs (plain text, emphasis, link text) get the contraction-spacing
  // repair; code spans and URLs go through `mark` untouched.
  const markProse = (value: string, slot: string) =>
    mark(repairProse ? repairContractionSpacing(value) : value, slot);
  const pattern =
    /(\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let lastIndex = 0;
  let index = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      nodes.push(...markProse(text.slice(lastIndex, match.index), `g${index}`));
    }
    if (match[2]) {
      nodes.push(
        <strong key={`strong-${keySeed}-${index}`}>{markProse(match[2], `s${index}`)}</strong>,
      );
    } else if (match[3]) {
      nodes.push(<em key={`em-${keySeed}-${index}`}>{markProse(match[3], `e${index}`)}</em>);
    } else if (match[4]) {
      nodes.push(<del key={`del-${keySeed}-${index}`}>{markProse(match[4], `d${index}`)}</del>);
    } else if (match[5]) {
      nodes.push(<code key={`code-${keySeed}-${index}`}>{mark(match[5], `c${index}`)}</code>);
    } else if (match[6] && match[7]) {
      nodes.push(
        <a key={`link-${keySeed}-${index}`} href={match[7]} rel="noreferrer" target="_blank">
          {markProse(match[6], `a${index}`)}
        </a>,
      );
    }
    lastIndex = pattern.lastIndex;
    index += 1;
    match = pattern.exec(text);
  }
  if (lastIndex < text.length) {
    nodes.push(...markProse(text.slice(lastIndex), "t"));
  }
  return nodes;
}

function eventText(event: HermesGatewayEvent) {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return "";
  for (const key of [
    "text",
    "delta",
    "message",
    "summary",
    "status",
    "content",
    "output",
    "result",
    "command",
  ]) {
    const value = stringValue(
      payload[key],
      key === "text" || key === "delta" || key === "message" || key === "content",
    );
    if (value) return value;
  }
  return "";
}

function stringValue(value: unknown, preserveWhitespace = false) {
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    return preserveWhitespace ? value : value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
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
    sessionModelOverrides?: Record<string, string>;
  },
) {
  const currentById = new Map(current.map((session) => [session.id, session]));
  const defaultModelId = options.defaultModelId?.trim();
  const sessionModelOverrides = options.sessionModelOverrides ?? {};
  const mergedFresh = fresh.map((session) => {
    const overrideModel = sessionModelOverrides[session.id]?.trim();
    if (overrideModel) return { ...session, model: overrideModel };
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
  liveEvents: Record<string, LiveHermesEvent[]>,
) {
  return (
    workingSessionIds.has(sessionId) ||
    waitingSessionIds.has(sessionId) ||
    (liveEvents[sessionId]?.length ?? 0) > 0
  );
}

function isTerminalHermesEvent(type: string) {
  const normalized = type.toLowerCase();
  return (
    normalized === "error" ||
    normalized === "message.complete" ||
    normalized === "message.completed" ||
    normalized === "turn.complete" ||
    normalized === "turn.completed" ||
    normalized === "session.complete" ||
    normalized === "session.completed" ||
    normalized === "background.complete" ||
    normalized === "background.completed"
  );
}

function hermesToolEventPhase(type: string): HermesToolEventPhase | undefined {
  const normalized = type.toLowerCase();
  if (normalized === "tool.complete") return "complete";
  if (normalized === "tool.start") return "start";
  if (normalized === "tool.progress") return "progress";
  return undefined;
}

function toolEventActivityKey(event: HermesGatewayEvent) {
  const payload = event.payload as Record<string, unknown> | undefined;
  return (
    stringValue(payload?.tool_id) ??
    stringValue(payload?.tool_call_id) ??
    stringValue(payload?.call_id) ??
    stringValue(payload?.id) ??
    stringValue(payload?.request_id)
  );
}

function agentStatusFromHermesEvent(event: HermesGatewayEvent): AgentSessionStatusKind | undefined {
  if (event.type === "error") return "failed";
  if (event.type === "clarify.request" || event.type === "approval.request") {
    return "waitingForUser";
  }
  if (event.type === "clarify.response" || event.type === "approval.response") {
    return "running";
  }
  if (isTerminalHermesEvent(event.type)) return "completed";
  if (
    event.type === "message.start" ||
    event.type === "thinking.delta" ||
    event.type === "reasoning.delta" ||
    event.type === "status.update" ||
    event.type.startsWith("tool.")
  ) {
    return "running";
  }
  return undefined;
}

function agentStatusSummaryFromHermesEvent(
  event: HermesGatewayEvent,
  status: AgentSessionStatusKind,
) {
  if (status === "waitingForUser") {
    return event.type === "approval.request" ? "June needs approval." : "June has a question.";
  }
  if (status === "completed") return "June finished.";
  if (status === "failed") return eventText(event) || "June hit a problem.";
  if (event.type === "status.update") {
    return eventText(event) || "June is working.";
  }
  if (event.type.startsWith("tool.")) {
    const payload = event.payload as Record<string, unknown> | undefined;
    const name =
      stringValue(payload?.name) ?? stringValue(payload?.tool_name) ?? stringValue(payload?.tool);
    return toolActivitySentence(name, payload);
  }
  if (event.type === "thinking.delta" || event.type === "reasoning.delta") {
    return "Thinking.";
  }
  return "June is working.";
}

function visibleHermesMessageText(message: HermesSessionMessage) {
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

function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const itemFiles =
    data.items && data.items.length
      ? Array.from(data.items)
          .filter((item) => item.kind === "file" && isClipboardImageType(item.type))
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file))
      : [];
  if (itemFiles.length) return normalizeClipboardImageFiles(itemFiles);
  return normalizeClipboardImageFiles(
    Array.from(data.files ?? []).filter((file) => isClipboardImageType(file.type)),
  );
}

function normalizeClipboardImageFiles(files: File[]): File[] {
  if (files.length <= 1 || hasDistinctClipboardFileNames(files)) {
    return files.map(ensureClipboardImageName);
  }
  const best = [...files].sort(
    (left, right) => clipboardImageRank(right) - clipboardImageRank(left),
  )[0];
  return best ? [ensureClipboardImageName(best, 0)] : [];
}

function hasDistinctClipboardFileNames(files: File[]) {
  const names = files.map((file) => file.name.trim()).filter(Boolean);
  const stems = names.map(clipboardImageStem);
  return (
    names.length === files.length &&
    new Set(names).size === files.length &&
    new Set(stems).size === files.length
  );
}

function ensureClipboardImageName(file: File, index: number) {
  if (file.name.trim()) return file;
  const suffix = index === 0 ? "" : `-${index + 1}`;
  return new File([file], `pasted-image${suffix}.${clipboardImageExtension(file)}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

function isClipboardImageType(type: string) {
  const mimeType = normalizedImageMimeType(type);
  return (
    mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/jpg" ||
    mimeType === "image/tiff" ||
    mimeType === "image/tif" ||
    mimeType === "image/gif" ||
    mimeType === "image/webp"
  );
}

function clipboardImageExtension(file: File) {
  const mimeType = normalizedImageMimeType(file.type);
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/tiff" || mimeType === "image/tif") return "tiff";
  const subtype = mimeType.startsWith("image/") ? mimeType.slice(6) : "";
  return subtype.replace(/[^a-z0-9]/g, "") || "png";
}

function clipboardImageStem(name: string) {
  const trimmed = name.trim().toLowerCase();
  const dot = trimmed.lastIndexOf(".");
  return dot > 0 ? trimmed.slice(0, dot) : trimmed;
}

function clipboardImageRank(file: File) {
  const mimeType = normalizedImageMimeType(file.type);
  if (mimeType === "image/png") return 50;
  if (mimeType === "image/tiff" || mimeType === "image/tif") return 40;
  if (mimeType === "image/webp") return 30;
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return 20;
  if (mimeType === "image/gif") return 10;
  return 1;
}

function normalizedImageMimeType(type: string) {
  return type.toLowerCase().split(";")[0];
}

function toolNames(toolset: HermesToolsetInfo) {
  return Array.isArray(toolset.tools) ? toolset.tools : [];
}

function stateLabel(value: string) {
  return value.replaceAll("_", " ");
}

function envFieldSet(field: HermesMessagingEnvVarInfo) {
  return Boolean(field.isSet ?? field.is_set);
}

function fieldLabel(field: HermesMessagingEnvVarInfo) {
  return field.prompt || field.key.replaceAll("_", " ").toLowerCase();
}

function messagingTrimEdits(edits: Record<string, string>) {
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

// Bottom-of-timeline "responding" affordance: a shimmering label, reusing the
// same text-shimmer the recorder uses while transcribing. Lives in the timeline
// (not the header) so it reads like the agent is actively composing the next
// turn.
function AgentThinking() {
  return (
    <div className="agent-thinking" role="status" aria-live="polite">
      <span className="text-shimmer agent-thinking-label">Thinking…</span>
    </div>
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
  options?: { category?: ReportCategory },
) {
  try {
    const payload = JSON.stringify({
      createdAt: Date.now(),
      prompt: prompt?.trim() || undefined,
      category: options?.category,
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

function pendingNewSessionRequest(): AgentNewSessionDetail | undefined {
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
      };
      if (
        typeof parsed.createdAt !== "number" ||
        Date.now() - parsed.createdAt > AGENT_NEW_SESSION_PENDING_TTL_MS
      ) {
        return undefined;
      }
      return {
        ...(typeof parsed.prompt === "string" ? { prompt: parsed.prompt } : {}),
        ...(isReportCategory(parsed.category) ? { category: parsed.category } : {}),
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
