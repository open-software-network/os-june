import { listen } from "@tauri-apps/api/event";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowsRepeat } from "central-icons/IconArrowsRepeat";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconBubbleWide } from "central-icons/IconBubbleWide";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
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
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCameraSparkle } from "central-icons/IconCameraSparkle";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconConsoleSimple } from "central-icons/IconConsoleSimple";
import { IconWallet3 } from "central-icons/IconWallet3";
import { IconDeepSearch } from "central-icons/IconDeepSearch";
import { IconConcise } from "central-icons/IconConcise";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFiles } from "central-icons/IconFiles";
import { IconFileSparkle } from "central-icons/IconFileSparkle";
import { IconFileText } from "central-icons/IconFileText";
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
  type FormEvent,
  type DragEvent,
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
} from "react";
import { BackButton } from "../ui/BackButton";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { HoverTip } from "../ui/HoverTip";
import { InlineNotice } from "../ui/InlineNotice";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Spinner } from "../ui/Spinner";
import {
  cancelAgentTask,
  createAgentTask,
  dictationHelperCommand,
  explainAgentApproval,
  getAgentTask,
  ensureHermesBridgeSession,
  hermesBridgeFilesystemSnapshot,
  hermesBridgeMessagingPlatforms,
  hermesBridgeFilePreview,
  hermesBridgeFileText,
  hermesAgentCliAccess,
  hermesBridgeSkills,
  hermesBridgeStatus,
  hermesBridgeToolsets,
  importHermesBridgeFile,
  importHermesBridgeFileBytes,
  listVeniceModels,
  listAgentTasks,
  downloadHermesBridgeFile,
  osAccountsTopUp,
  providerModelSettings,
  retryAgentTask,
  sendAgentMessage,
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
  type AgentReplyDetail,
  type AgentSessionsChangedDetail,
  type AgentSessionStatusKind,
} from "../../lib/agent-events";
import {
  HermesGatewayClient,
  isSessionBusyError,
  type HermesGatewayEvent,
} from "../../lib/hermes-gateway";
import {
  PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
  dispatchProviderModelSettingsChanged,
  modelPrivacyBadge,
  modelSupportsTools,
  type ModelPrivacyBadge,
  type ProviderModelSettingsChangedDetail,
} from "../../lib/model-privacy";
import { suggestedModelsForMode } from "../../lib/suggested-models";
import {
  contextLabel,
  modelOptions,
  pricingLabel,
  selectedModel as selectedModelOption,
} from "../settings/ModelPickerDialog";
import {
  isHermesSessionsStartupRequestError,
  messageFromError,
} from "../../lib/errors";
import {
  categoryPrompt,
  displayedUserMessageText,
} from "../../lib/issue-report-prompt";
import {
  ComposerEditor,
  type ComposerEditorHandle,
} from "./composer/ComposerEditor";
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
import {
  AGENT_CLI_ACCESS_ENABLED_MESSAGE,
  hasAgentCliAccessRequest,
  stripAgentCliAccessRequest,
} from "../../lib/agent-cli-access";
import {
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
  repairContractionSpacing,
  type AgentApprovalChoice,
  type AgentChatPart,
  type AgentChatTurn,
  type LiveHermesEvent,
} from "../../lib/agent-chat-runtime";
import {
  buildAgentChatGallery,
  buildAgentErrorGallery,
  type AgentChatGallerySection,
} from "../../lib/agent-chat-gallery";
import { attachScrollThumbFade } from "../../lib/scroll-thumb-fade";

const POLLED_STATUSES = new Set<AgentTaskStatus>([
  "queued",
  "running",
  "waitingForUser",
]);
const AGENT_TITLE_TIMEOUT_MS = 2500;
const AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const AGENT_WORKSPACE_MAX_SESSION_RETRY_DELAY_MS =
  AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS[
    AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS.length - 1
  ] ?? 2000;

// What the user reads instead of the gateway's "session busy" rejection. No
// action in the pill — the composer's send slot already shows stop while
// June works.
const SESSION_BUSY_NOTICE = "June is still working on the previous message.";

// Connection-shaped failures get a "Try again" on the error banner — these are
// all our own strings (hermes-gateway.ts client errors, ensureHermesGateway),
// so the match is stable. Other errors (downloads, renames…) have no single
// retryable action, so they only offer dismiss.
const GATEWAY_CONNECTION_ERROR = /hermes (gateway|bridge)/i;

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
  (window as unknown as Record<string, unknown>).__agentGallery = (
    show: boolean = true,
  ) => {
    setGalleryDesired(show);
    return show
      ? "Agent response gallery shown. Run __agentGallery(false) to hide."
      : "Agent response gallery hidden.";
  };
  // Error-focused variant: just the failure sections, plus the chrome-level
  // error surfaces (error banner, composer busy notice) the turn-based
  // gallery can't represent.
  (window as unknown as Record<string, unknown>).__agentErrors = (
    show: boolean = true,
  ) => {
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
const AGENT_DEV_FILES_EVENT = "scribe:agent:dev-files";

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__agentFiles = (
    show: boolean = true,
  ) => {
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
  const binary = new Uint8Array(512).map((_, index) =>
    index % 2 ? 0xfe : 0xff,
  );
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
    gradient.addColorStop(0, "#c25a33");
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
    prompt:
      "Research <topic> and write a short summary of what you find, with sources.",
    action: "prefill",
  },
  {
    key: "summarize-file",
    icon: <IconFileSparkle size={18} />,
    title: "Summarize a file",
    description: "Pick a document and get the key points out of it.",
    prompt:
      "Summarize the key points of the attached file and pull out any action items.",
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
    prompt:
      "Find <a file I half-remember> on my computer and tell me where it is.",
    action: "prefill",
  },
  {
    key: "describe-screenshots",
    icon: <IconCameraSparkle size={18} />,
    title: "Find the right screenshot",
    description: "June looks through them so you don't have to.",
    prompt:
      "Look through the recent screenshots on my Desktop and in my Downloads folder, open each one, and tell me what it shows so I can find the one I'm looking for. Don't rename, move, or change anything.",
    action: "run",
  },
  {
    key: "draft-document",
    icon: <IconPencilLine size={18} />,
    title: "Draft a document",
    description: "Start a write-up and get it as a downloadable file.",
    prompt:
      "Draft a <kind of document> about <topic>, then save it as a Markdown file in your workspace so I can download it.",
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
    prompt:
      "Extract all the text from the attached file and clean it up into tidy Markdown.",
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

const HERO_GREETING_INDEX_KEY = "scribe:agent:hero-greeting";

function advanceHeroGreeting(): string {
  try {
    const index =
      Math.abs(
        Number.parseInt(
          window.localStorage.getItem(HERO_GREETING_INDEX_KEY) ?? "0",
          10,
        ) || 0,
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
  attachmentNames: string[];
  /** Workspace paths captured at submit, so the files can be uploaded with
   * the report even after the composer clears its attachment chips. */
  attachmentPaths: string[];
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
};

/** The right-hand file viewer: a list of every file surfaced in the
 * conversation, or one file opened for reading. */
type AgentArtifactPanelState =
  | { view: "list" }
  | { view: "file"; artifact: AgentArtifact };

type TauriFileDropPayload = {
  paths?: string[];
};

type HermesRuntimeSessionResponse = {
  session_id?: string;
  stored_session_id?: string;
};

/** Where the session was opened from — rendered as the leading crumbs in the
 * sticky session bar ("Projects / Scribe" or "Agents") with a back arrow. */
export type AgentWorkspaceOrigin = {
  backLabel: string;
  onBack: () => void;
  crumbs: { label: string; onClick: () => void }[];
};

type AgentWorkspaceProps = {
  initialSession?: HermesSessionInfo;
  pendingReply?: AgentReplyDetail;
  origin?: AgentWorkspaceOrigin;
};

// Module-scoped so a remount of AgentWorkspace (e.g. navigating away from the
// agent view and back) does not re-submit an agent HUD reply that App still holds
// in its pendingReply state.
const handledHudReplyIds = new Set<string>();

// Mid-run continuity across remounts. While June is working, a session has
// state that exists nowhere outside this component: the optimistic list entry
// (title + preview), the just-sent user bubble Hermes hasn't persisted yet,
// the working/waiting flags that drive the reconcile poll, the stored→runtime
// session mapping, the buffered live events, and the title override.
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
};

let sessionContinuity: AgentSessionContinuity | null = null;

function captureSessionContinuity(state: {
  sessionItems: HermesSessionInfo[];
  pendingMessages: Record<string, HermesSessionMessage[]>;
  workingSessionIds: Set<string>;
  waitingSessionIds: Set<string>;
  runtimeSessionIds: Record<string, string>;
  liveEvents: Record<string, LiveHermesEvent[]>;
  titleOverrides: Record<string, string>;
}): AgentSessionContinuity | null {
  const activeIds = new Set([
    ...state.workingSessionIds,
    ...state.waitingSessionIds,
  ]);
  for (const [sessionId, pending] of Object.entries(state.pendingMessages)) {
    if (pending.length > 0) activeIds.add(sessionId);
  }
  if (activeIds.size === 0) return null;
  const pick = <T,>(record: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(record).filter(([sessionId]) => activeIds.has(sessionId)),
    );
  return {
    sessionItems: state.sessionItems.filter((session) =>
      activeIds.has(session.id),
    ),
    pendingMessages: pick(state.pendingMessages),
    workingSessionIds: [...state.workingSessionIds],
    waitingSessionIds: [...state.waitingSessionIds],
    runtimeSessionIds: pick(state.runtimeSessionIds),
    liveEvents: pick(state.liveEvents),
    titleOverrides: pick(state.titleOverrides),
  };
}

/** Test hook: the snapshot is module state, so a test that unmounts with a
 * working session (testing-library auto-cleanup) would otherwise leak it into
 * the next test's mount. */
export function resetAgentSessionContinuity() {
  sessionContinuity = null;
}

export function AgentWorkspace({
  initialSession,
  pendingReply,
  origin,
}: AgentWorkspaceProps = {}) {
  const initialSessionId = initialSession?.id;
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
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [importingFiles, setImportingFiles] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A rejected send into a still-running session, explained by the composer.
  // Separate from `error` because background session refreshes clear that
  // banner on success — this notice must survive until the turn finishes.
  const [busyNotice, setBusyNotice] = useState<string | null>(null);
  // Confirmation that a submitted issue report reached the June team; shown
  // in the composer notice slot until dismissed by the next send.
  const [issueReportNotice, setIssueReportNotice] = useState<string | null>(
    null,
  );
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
  const [hermesSessionItems, setHermesSessionItems] = useState<
    HermesSessionInfo[]
  >(() => {
    const restored = continuity?.sessionItems ?? [];
    if (!initialSession) return restored;
    return [
      initialSession,
      ...restored.filter((session) => session.id !== initialSession.id),
    ];
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
  // new-session marker overrides the restore: the mount-time sessions-changed
  // dispatch would otherwise announce the restored session as selected, which
  // App reads as "switched to an existing session" and drops a pending
  // project assignment before the new session even exists.
  const [selectedHermesSessionId, setSelectedHermesSessionId] = useState<
    string | undefined
  >(
    () =>
      initialSessionId ??
      (hasPendingNewSessionRequest() ? undefined : readLastOpenSessionId()),
  );
  const selectedHermesSessionIdRef = useRef<string | undefined>(
    selectedHermesSessionId,
  );
  const lastAutoSubmittedRef = useRef<{ prompt: string; at: number }>();
  const [newSessionMode, setNewSessionMode] = useState(
    () => !initialSessionId && hasPendingNewSessionRequest(),
  );
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
  const pendingHermesMessagesRef = useRef<
    Record<string, HermesSessionMessage[]>
  >(pendingHermesMessages);
  // Per-session ordering for message fetches: the sequence handed out at
  // fetch start, and the highest sequence whose response was applied. See
  // listSessionMessagesOrdered.
  const sessionMessagesFetchSeqRef = useRef<Map<string, number>>(new Map());
  const sessionMessagesAppliedSeqRef = useRef<Map<string, number>>(new Map());
  const [hermesSessionsLoading, setHermesSessionsLoading] = useState(false);
  const [liveEvents, setLiveEvents] = useState<
    Record<string, LiveHermesEvent[]>
  >(() => continuity?.liveEvents ?? {});
  const [thinkingOpenByKey, setThinkingOpenByKey] = useState<
    Record<string, boolean>
  >({});
  const [workingTaskIds, setWorkingTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [workingSessionIds, setWorkingSessionIds] = useState<Set<string>>(
    () => new Set(continuity?.workingSessionIds),
  );
  const workingSessionIdsRef = useRef<Set<string>>(workingSessionIds);
  const [waitingSessionIds, setWaitingSessionIds] = useState<Set<string>>(
    () => new Set(continuity?.waitingSessionIds),
  );
  const waitingSessionIdsRef = useRef<Set<string>>(waitingSessionIds);
  const [runtimeSessionIds, setRuntimeSessionIds] = useState<
    Record<string, string>
  >(() => continuity?.runtimeSessionIds ?? {});
  const runtimeSessionIdsRef = useRef(runtimeSessionIds);
  // Consecutive runtime-reconcile polls in which a locally-working session was
  // absent from the gateway's live list. Cleared the moment it's seen live.
  const workingReconcileMissesRef = useRef(new Map<string, number>());
  const [stoppingSessionIds, setStoppingSessionIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [skills, setSkills] = useState<HermesSkillInfo[] | null>(null);
  const [toolsets, setToolsets] = useState<HermesToolsetInfo[] | null>(null);
  const [messagingPlatforms, setMessagingPlatforms] = useState<
    HermesMessagingPlatformInfo[] | null
  >(null);
  // The active text model (global setting, not per-session) shown in the
  // composer's model pill; the catalog backs the picker the pill opens. A
  // selection missing from the catalog still shows as a name-only stub so
  // the pill never goes blank while a model is configured.
  const [generationModel, setGenerationModel] = useState<VeniceModelDto>();
  const [generationModels, setGenerationModels] = useState<VeniceModelDto[]>(
    [],
  );
  const [composerModelOpen, setComposerModelOpen] = useState(false);
  const [composerModelFlyout, setComposerModelFlyout] =
    useState<ComposerModelFlyout>(null);
  const [modelSearch, setModelSearch] = useState("");
  const composerModelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const composerModelPopoverRef = useRef<HTMLDivElement | null>(null);
  const composerModelSearchRef = useRef<HTMLInputElement | null>(null);
  const generationPrivacyBadge = generationModel
    ? modelPrivacyBadge(generationModel)
    : undefined;
  // Attestation walkthrough URL served by the backend (same page as Settings
  // → About → Verify server); the privacy badge links to it when known.
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [capabilitySaving, setCapabilitySaving] = useState<string | null>(null);
  const [selectedMessagingPlatformId, setSelectedMessagingPlatformId] =
    useState<string>();
  const [messagingEnvEdits, setMessagingEnvEdits] = useState<
    Record<string, string>
  >({});
  const [filesystemSnapshot, setFilesystemSnapshot] =
    useState<HermesFilesystemSnapshot | null>(null);
  const [filesystemLoading, setFilesystemLoading] = useState(false);
  const [artifactPanel, setArtifactPanel] =
    useState<AgentArtifactPanelState | null>(null);
  // Dev-only sample files seeded by window.__agentFiles — surfaced alongside
  // the conversation's own artifacts so the viewer can be exercised at will.
  const [devArtifacts, setDevArtifacts] = useState<AgentArtifact[]>([]);
  const [approvalSubmitting, setApprovalSubmitting] = useState<
    Partial<Record<string, AgentApprovalChoice>>
  >({});
  const [clarifySubmitting, setClarifySubmitting] = useState<
    Record<string, string>
  >({});
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
  const [gallerySections, setGallerySections] = useState<
    AgentChatGallerySection[] | null
  >(null);
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
  // sessionId -> the report captured at submit time, delivered to the June
  // team once the agent's diagnostic turn reaches a terminal event.
  const pendingIssueReportsRef = useRef<Map<string, PendingIssueReport>>(
    new Map(),
  );
  // True only while a brand-new thread is being started from the hero. The
  // hero→dock composer FLIP keys off this so it glides *only* when the empty
  // chat hands over to a fresh thread — not when the hero is dismissed by
  // selecting an existing chat from the sidebar (that should swap instantly).
  const heroExitViaThreadRef = useRef(false);
  const sessionTitleOverridesRef = useRef<Record<string, string>>(
    continuity?.titleOverrides ?? {},
  );
  const titleSuggestionSessionIdsRef = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement | null>(null);
  const agentScrollRef = useRef<HTMLDivElement | null>(null);
  const composerEditorRef = useRef<ComposerEditorHandle | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  // A category to seed into the composer chip once the editor is ready, set by
  // startNewTask for the sidebar/settings report entry points.
  const pendingSeedCategoryRef = useRef<ReportCategory | null>(null);

  useEffect(() => {
    runtimeSessionIdsRef.current = runtimeSessionIds;
  }, [runtimeSessionIds]);

  useEffect(() => {
    selectedHermesSessionIdRef.current = selectedHermesSessionId;
    workingSessionIdsRef.current = workingSessionIds;
    waitingSessionIdsRef.current = waitingSessionIds;
    pendingHermesMessagesRef.current = pendingHermesMessages;
    hermesSessionItemsRef.current = hermesSessionItems;
  }, [
    hermesSessionItems,
    pendingHermesMessages,
    selectedHermesSessionId,
    waitingSessionIds,
    workingSessionIds,
  ]);

  const setSessionWorking = useCallback(
    (sessionId: string, working: boolean) => {
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
    },
    [],
  );

  const setSessionWaiting = useCallback(
    (sessionId: string, waiting: boolean) => {
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
    },
    [],
  );

  const clearSessionActivity = useCallback((sessionId: string) => {
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
  }, []);

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
    () =>
      hermesSessionItems.find(
        (session) => session.id === selectedHermesSessionId,
      ),
    [hermesSessionItems, selectedHermesSessionId],
  );
  const selectedHermesMessages = useMemo(() => {
    if (!selectedHermesSessionId) return [];
    return [
      ...(hermesSessionMessages[selectedHermesSessionId] ?? []),
      ...(pendingHermesMessages[selectedHermesSessionId] ?? []),
    ];
  }, [hermesSessionMessages, pendingHermesMessages, selectedHermesSessionId]);
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
          imported.push(
            await importHermesBridgeFileBytes(sample.name, sample.bytes),
          );
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
    !gallerySections &&
    (newSessionMode || (!selectedHermesSessionId && !selectedTask));
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
      return [task, ...rest].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    });
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const response = await listAgentTasks();
      setTasks(response.items);
      setSelectedTaskId((current) =>
        newSessionModeRef.current
          ? undefined
          : (current ?? response.items[0]?.id),
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
          if (
            taskSession &&
            sessions.some((session) => session.id === taskSession)
          ) {
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
        settingsResponse.settings.generationModel ||
        modelsResponse.selectedModel;
      if (requestId === generationModelRequestSequence.current) {
        setGenerationModels(modelsResponse.models);
        setGenerationModel(
          selectedModelId
            ? selectedModelOption(modelsResponse.models, selectedModelId)
            : undefined,
        );
      }
    } catch {
      if (requestId === generationModelRequestSequence.current) {
        setGenerationModel(undefined);
      }
    }
  }, []);

  useEffect(() => {
    function handleProviderModelSettingsChanged(event: Event) {
      const { mode } = (
        event as CustomEvent<ProviderModelSettingsChangedDetail>
      ).detail;
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

  // The picker writes the global text-model setting, so the change is
  // dispatched app-wide: Settings' model rows and this pill both refresh
  // through the same changed event.
  async function handleSelectGenerationModel(modelId: string) {
    setComposerModelOpen(false);
    try {
      await setVeniceModel("generation", modelId);
      dispatchProviderModelSettingsChanged({ mode: "generation", modelId });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  useEffect(() => {
    if (!bridge.running) return;
    let cancelled = false;
    let retryTimeout: number | undefined;

    function load(attempt: number) {
      void loadHermesSessions({ suppressStartupRequestError: true }).then(
        (result) => {
          if (cancelled || result !== "transient-startup-error") return;
          const retryDelay =
            AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS[attempt] ??
            AGENT_WORKSPACE_MAX_SESSION_RETRY_DELAY_MS;
          retryTimeout = window.setTimeout(() => load(attempt + 1), retryDelay);
        },
      );
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
    if (initialSession) {
      setHermesSessionItems((current) =>
        current.some((session) => session.id === initialSession.id)
          ? current
          : [initialSession, ...current],
      );
    }
  }, [initialSession, initialSessionId]);

  // Remember the open conversation for the restore-on-mount above. Entering
  // new-session mode leaves the last real session in place — if the new
  // session never materializes (crash, reload), restoring the previous one
  // beats landing on the hero screen.
  useEffect(() => {
    if (selectedHermesSessionId) {
      writeLastOpenSessionId(selectedHermesSessionId);
    }
  }, [selectedHermesSessionId]);

  useEffect(() => {
    if (!pendingReply?.text.trim()) return;
    if (handledHudReplyIds.has(pendingReply.requestId)) return;
    handledHudReplyIds.add(pendingReply.requestId);
    void submitHudReply(pendingReply);
  }, [pendingReply]);

  useEffect(() => {
    // The sidebar and App replace their session lists wholesale with this
    // payload, so an unhydrated broadcast (mount seed only) would collapse
    // the list they already fetched themselves and flicker it back once the
    // real fetch lands.
    if (!hermesSessionsHydrated) return;
    dispatchAgentSessionsChanged({
      sessions: hermesSessionItems,
      selectedSessionId: selectedHermesSessionId,
      workingSessionIds: Array.from(workingSessionIds),
      waitingSessionIds: Array.from(waitingSessionIds),
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
      windowEventHandlersRef.current.removeHermesSessionLocally(
        detail.sessionId,
      );
    }

    const pending = pendingNewSessionRequest();
    if (pending) {
      void windowEventHandlersRef.current.startNewTask(pending);
    }

    window.addEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
    window.addEventListener(AGENT_DELETE_SESSION_EVENT, handleDeleteSession);
    return () => {
      window.removeEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
      window.removeEventListener(
        AGENT_DELETE_SESSION_EVENT,
        handleDeleteSession,
      );
    };
  }, []);

  useEffect(() => {
    if (!bridge.running || !selectedHermesSessionId) return;
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
                hermesSessionItems.find(
                  (session) => session.id === selectedHermesSessionId,
                )?.title ?? "Agent session",
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
        if (!cancelled) setError(messageFromError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge.running, selectedHermesSessionId]);

  useEffect(() => {
    if (!bridge.running || !selectedHermesSessionId) return;
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
          setTasks((current) =>
            current.map((item) => (item.id === fullTask.id ? fullTask : item)),
          );
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
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const installListener = async (eventName: string) => {
      const unlisten = await listen<TauriFileDropPayload>(
        eventName,
        (event) => {
          const paths = event.payload?.paths ?? [];
          if (paths.length) {
            void importDroppedFilePaths(paths);
          }
        },
      );
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

  // The busy notice's advice ("wait for the reply") expires the moment the
  // selected session stops working — including when the user switches to a
  // session that isn't running.
  useEffect(() => {
    if (!busyNotice) return;
    if (
      selectedHermesSessionId &&
      workingSessionIds.has(selectedHermesSessionId)
    )
      return;
    setBusyNotice(null);
  }, [busyNotice, selectedHermesSessionId, workingSessionIds]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const message = draft.trim();
    if ((!message && !attachments.length) || submitting || importingFiles)
      return;
    // The composer's category chip makes this a report: wrap the prompt to
    // frame it for the team and queue the delivery. Captured before the
    // composer clears so a failed send can restore the chip on retry.
    const reportCategory = category;
    const content = promptWithAttachments(message, attachments);
    // A typed hero submit plays the same teardown as a run shortcut: greeting
    // up, suggestions down during the session-create latency. Without it they
    // sit frozen through the wait and then vanish in a single frame when the
    // conversation takes over.
    if (heroMode) setHeroLeaving(true);
    setSubmitting(true);
    composerEditorRef.current?.clear();
    setDraft("");
    setCategory(null);
    setAttachments([]);
    setIssueReportNotice(null);
    try {
      await submitHermesSession(
        reportCategory ? categoryPrompt(reportCategory, content) : content,
        undefined,
        reportCategory
          ? {
              issueReport: {
                category: reportCategory,
                // An attachments-only send has no typed text, but the server
                // requires a description; the report must not bounce there.
                description:
                  message || "No description was typed; see the attachments.",
                attachmentNames: attachments.map(
                  (attachment) => attachment.name,
                ),
                attachmentPaths: attachments.map(
                  (attachment) => attachment.path,
                ),
              },
            }
          : undefined,
      );
      setError(null);
      setBusyNotice(null);
    } catch (err) {
      // Restore the composer so a failed send doesn't eat the message, its
      // category chip, or its attachments — but only where the user hasn't
      // typed or attached something new during the in-flight send.
      if (composerEditorRef.current?.isEmpty() ?? true) {
        composerEditorRef.current?.setContent(message, reportCategory);
      }
      setAttachments((current) => (current.length ? current : attachments));
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
    }
  }

  async function submitHudReply(reply: AgentReplyDetail) {
    const message = reply.text.trim();
    if (!message) return;
    if (submitting || importingFiles) {
      // Another submission is in flight; keep the reply in the composer
      // instead of dropping it silently.
      composerEditorRef.current?.setContent(message);
      return;
    }
    const targetSession = reply.session;
    setActivePanel("chat");
    setSelectedTaskId(undefined);
    composerEditorRef.current?.clear();
    setAttachments([]);
    if (targetSession?.id) {
      newSessionModeRef.current = false;
      setNewSessionMode(false);
      selectedHermesSessionIdRef.current = targetSession.id;
      setSelectedHermesSessionId(targetSession.id);
      setHermesSessionItems((current) =>
        current.some((session) => session.id === targetSession.id)
          ? current
          : [targetSession, ...current],
      );
    }
    setSubmitting(true);
    try {
      await submitHermesSession(message, targetSession);
      setError(null);
      setBusyNotice(null);
    } catch (err) {
      // Same merge-restore as submit(): don't clobber a draft the user
      // started typing while the reply was in flight.
      if (composerEditorRef.current?.isEmpty() ?? true) {
        composerEditorRef.current?.setContent(message);
      }
      if (isSessionBusyError(err)) {
        // Same as submit(): a 4009 proves the gateway is healthy, so a stale
        // connection banner must not outlive it.
        setError(null);
        setBusyNotice(SESSION_BUSY_NOTICE);
      } else {
        setError(messageFromError(err));
      }
    } finally {
      setSubmitting(false);
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

  async function importAttachments<T>(
    items: T[],
    importItem: (item: T) => Promise<ImportedHermesFile>,
  ) {
    if (!items.length) return;
    setImportingFiles(true);
    try {
      // One at a time on purpose: a dropped file's bytes can be 50 MB, so
      // interleave read and upload to keep at most one buffer alive instead
      // of staging the whole batch (up to ~400 MB) in memory at once.
      const imported: ImportedHermesFile[] = [];
      for (const item of items) {
        imported.push(await importItem(item));
      }
      setAttachments((current) => [
        ...current,
        ...imported.map((file) => ({
          ...file,
          id: `${file.path}:${Date.now()}:${Math.random().toString(36)}`,
        })),
      ]);
      setError(null);
      void loadFilesystemSnapshot();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setImportingFiles(false);
    }
  }

  // Native paths come from the file picker and Tauri drag-drop events.
  async function importDroppedFilePaths(paths: string[]) {
    const uniquePaths = Array.from(new Set(paths.map((path) => path.trim())))
      .filter(Boolean)
      .slice(0, 8);
    await importAttachments(uniquePaths, importHermesBridgeFile);
  }

  // DOM drops are how Finder files actually arrive: Tauri's drag-drop
  // interception is disabled (it has to be, so notes can use HTML5 drag into
  // folders) and WKWebView never exposes filesystem paths on dropped Files —
  // so read each blob and import its bytes.
  async function importDroppedFiles(files: File[]) {
    await importAttachments(files.slice(0, 8), async (file) => {
      if (file.size > 50 * 1024 * 1024) {
        throw new Error("Dropped files must be 50 MB or smaller.");
      }
      const bytes = await readFileBytes(file).catch(() => {
        // Reading fails for directories, which Finder happily lets you drop.
        throw new Error(
          `Could not read "${file.name}". Folders can't be attached.`,
        );
      });
      return importHermesBridgeFileBytes(file.name, bytes);
    });
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
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
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await importDroppedFilePaths(paths);
    } catch (err) {
      setError(messageFromError(err));
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
  ) {
    let agentDiagnosis: string | undefined;
    try {
      const messages = await listHermesSessionMessages(sessionId);
      agentDiagnosis = messages
        .slice()
        .reverse()
        .map((message) =>
          message.role === "assistant" ? visibleHermesMessageText(message) : "",
        )
        .find((text) => text.trim())
        ?.trim();
    } catch {
      // Best-effort; the report ships without the diagnosis.
    }
    try {
      await submitIssueReport({
        category: report.category,
        description: report.description,
        agentDiagnosis,
        attachmentNames: report.attachmentNames,
        attachmentPaths: report.attachmentPaths,
        sessionId,
      });
      setIssueReportNotice(
        "Your report was sent to the June team. Thank you for helping improve June.",
      );
    } catch (err) {
      setError(`The issue report could not be sent. ${messageFromError(err)}`);
    }
  }

  async function submitHermesSession(
    content: string,
    explicitSession?: HermesSessionInfo,
    options?: { issueReport?: PendingIssueReport },
  ) {
    const targetSessionId = explicitSession?.id
      ? explicitSession.id
      : newSessionModeRef.current
        ? undefined
        : selectedHermesSessionId;
    // Issue reports skip title suggestion: the content is the wrapped
    // investigation prompt, which would title the session after the wrapper.
    const titlePromise =
      targetSessionId || options?.issueReport
        ? undefined
        : agentSessionTitleForPrompt(content);
    // The Unrestricted opt-in is made per session: a new session applies the
    // picker draft, and a follow-up routes to the runtime process matching
    // the mode its session was created with. Without this, one Unrestricted
    // session would leave the runtime unsandboxed under every other
    // session's follow-ups.
    const gateway = await ensureHermesGateway(
      targetSessionId
        ? sessionUnrestricted(targetSessionId)
        : fullModeDraftRef.current,
    );
    const sessionTitle = titlePromise ? await titlePromise : undefined;
    const created = targetSessionId
      ? undefined
      : await gateway.request<HermesRuntimeSessionResponse>("session.create", {
          title: options?.issueReport
            ? "Issue report"
            : (sessionTitle ?? titleFromPrompt(content)),
          cols: 96,
        });
    const storedSessionId =
      targetSessionId ?? created?.stored_session_id ?? created?.session_id;
    if (!storedSessionId) throw new Error("Hermes did not create a session.");
    if (options?.issueReport && !targetSessionId) {
      pendingIssueReportsRef.current.set(storedSessionId, options.issueReport);
    }
    if (!targetSessionId) {
      rememberSessionMode(storedSessionId, fullModeDraftRef.current);
    }
    const sessionDisplayTitle = options?.issueReport
      ? "Issue report"
      : explicitSession?.title?.trim() ||
        explicitSession?.preview?.trim() ||
        sessionTitle ||
        titleFromPrompt(content);
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
    await withTimeout(
      ensureHermesBridgeSession({
        sessionId: storedSessionId,
        title: sessionDisplayTitle,
      }),
      2500,
    ).catch(() => undefined);
    const runtimeSessionId =
      created?.session_id ??
      runtimeSessionIds[storedSessionId] ??
      (
        await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
          session_id: storedSessionId,
          cols: 96,
        })
      ).session_id;
    if (!runtimeSessionId)
      throw new Error("Hermes did not resume the session.");
    const createdAt = new Date().toISOString();
    // A new session (no target id) means the hero is handing over to a fresh
    // thread — arm the composer glide. Sending into an existing session leaves
    // the flag alone so a later hero dismissal via the sidebar stays instant.
    if (!targetSessionId) heroExitViaThreadRef.current = true;
    newSessionModeRef.current = false;
    setNewSessionMode(false);
    setRuntimeSessionIds((current) => ({
      ...current,
      [storedSessionId]: runtimeSessionId,
    }));
    selectedHermesSessionIdRef.current = storedSessionId;
    setSelectedHermesSessionId(storedSessionId);
    setSelectedTaskId(undefined);
    setHermesSessionItems((current) => {
      if (current.some((session) => session.id === storedSessionId))
        return current;
      return [
        {
          id: storedSessionId,
          title: sessionDisplayTitle,
          preview: content,
          started_at: createdAt,
          last_active: createdAt,
          message_count: 1,
        },
        ...current,
      ];
    });
    const pendingUserMessage: HermesSessionMessage = {
      id: `pending:user:${Date.now()}`,
      role: "user",
      content,
      timestamp: createdAt,
    };
    setPendingHermesMessages((current) => {
      const next = {
        ...current,
        [storedSessionId]: [
          ...(current[storedSessionId] ?? []),
          pendingUserMessage,
        ],
      };
      pendingHermesMessagesRef.current = next;
      return next;
    });
    setSessionWorking(storedSessionId, true);
    setSessionWaiting(storedSessionId, false);
    dispatchAgentSessionStatus({
      sessionId: storedSessionId,
      title: sessionDisplayTitle,
      prompt: content,
      status: "running",
      summary: "June is working.",
    });
    sessionGatewayUnlistenRef.current.get(storedSessionId)?.();
    const removeListener = gateway.onEvent((event) => {
      if (
        event.session_id !== runtimeSessionId &&
        event.session_id !== storedSessionId
      )
        return;
      const liveEvent = { ...event, receivedAt: new Date().toISOString() };
      const nextSessionEvents = [
        ...(liveEventsRef.current[storedSessionId] ?? []),
        liveEvent,
      ].slice(-200);
      liveEventsRef.current = {
        ...liveEventsRef.current,
        [storedSessionId]: nextSessionEvents,
      };
      setLiveEvents(liveEventsRef.current);
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
        // The diagnostic turn is over (even on error): file the report now so
        // the user's description isn't lost to a failed investigation.
        const issueReport = pendingIssueReportsRef.current.get(storedSessionId);
        if (issueReport) {
          pendingIssueReportsRef.current.delete(storedSessionId);
        }
        window.setTimeout(() => {
          void refreshHermesSession(storedSessionId);
          if (issueReport) {
            void deliverIssueReport(storedSessionId, issueReport);
          }
        }, 300);
      }
    });
    const unlisten = () => {
      removeListener();
      if (sessionGatewayUnlistenRef.current.get(storedSessionId) === unlisten) {
        sessionGatewayUnlistenRef.current.delete(storedSessionId);
      }
    };
    sessionGatewayUnlistenRef.current.set(storedSessionId, unlisten);
    try {
      await gateway.request("prompt.submit", {
        session_id: runtimeSessionId,
        text: content,
      });
      await loadHermesSessions({
        suppressStartupRequestError: !hermesSessionsHydratedRef.current,
      });
    } catch (err) {
      // A queued report must not outlive its failed prompt; submit() re-arms
      // issue-report mode so the retry files it again.
      pendingIssueReportsRef.current.delete(storedSessionId);
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
      unlisten();
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
    let connection = hermesConnectionForMode(
      bridge.running ? bridge : undefined,
      fullMode,
    );
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
            const resumed = await gateway.request<HermesRuntimeSessionResponse>(
              "session.resume",
              { session_id: sessionId, cols: 96 },
            );
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
    const modes = Array.from(
      new Set(working.map((sessionId) => sessionUnrestricted(sessionId))),
    );
    let rows: Array<{ id?: string; session_key?: string; status?: string }> =
      [];
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
        rows = rows.concat(
          Array.isArray(response?.sessions) ? response.sessions : [],
        );
        reachableModes.add(mode);
      } catch {
        // Can't reach this runtime — keep ITS sessions' current state rather
        // than guess, while the reachable mode still reconciles below.
      }
    }
    if (reachableModes.size === 0) return;
    const live = new Set<string>();
    for (const row of rows) {
      // "idle" means the runtime session exists but isn't processing a turn.
      if (!row || row.status === "idle") continue;
      if (row.session_key) live.add(String(row.session_key));
      if (row.id) live.add(String(row.id));
    }
    for (const sessionId of working) {
      // Sessions of an unreachable mode were not in any answer we got;
      // counting them as misses would mark live work dead.
      if (!reachableModes.has(sessionUnrestricted(sessionId))) continue;
      const runtimeSessionId = runtimeSessionIdsRef.current[sessionId];
      if (
        live.has(sessionId) ||
        (runtimeSessionId && live.has(runtimeSessionId))
      ) {
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
      // "completed" (not "failed") keeps the tray quiet: its title falls back
      // to lastStatus when nothing is active, and a stale "running" there
      // would still render "Working…".
      dispatchAgentSessionStatus({
        sessionId,
        title:
          hermesSessionItems.find((session) => session.id === sessionId)
            ?.title ?? "Agent session",
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
      if (
        sessionHasAssistantAfterLatestUser([...messages, ...retainedPending])
      ) {
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
              hermesSessionItems.find((session) => session.id === sessionId)
                ?.title ?? "Agent session",
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
      setError(messageFromError(err));
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
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (message.toLowerCase().includes("session not found")) {
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
        liveEventsRef.current = omitRecordKey(
          liveEventsRef.current,
          liveEventKey,
        );
        setLiveEvents(liveEventsRef.current);
        void loadHermesSessions();
      }
      setError(message);
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
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setClarifySubmitting((current) => {
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

  function pushLiveEvent(key: string, event: HermesGatewayEvent) {
    const liveEvent = { ...event, receivedAt: new Date().toISOString() };
    const nextEvents = [...(liveEventsRef.current[key] ?? []), liveEvent].slice(
      -200,
    );
    liveEventsRef.current = {
      ...liveEventsRef.current,
      [key]: nextEvents,
    };
    setLiveEvents(liveEventsRef.current);
  }

  async function startNewTask(request?: AgentNewSessionDetail) {
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
    setSelectedHermesSessionId(undefined);
    // Seed the composer: a category chip for a report, the prompt otherwise.
    // The editor may not be mounted yet on a cold open, so stash the category
    // for ComposerEditor's onReady to pick up and also try to apply now.
    pendingSeedCategoryRef.current = seedCategory;
    if (seedCategory) {
      seedComposerCategory();
    } else if (initialPrompt) {
      composerEditorRef.current?.setContent(initialPrompt);
    } else {
      clearComposerDraft();
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
      setError(null);
    } catch (err) {
      composerEditorRef.current?.setContent(initialPrompt);
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

  function clearComposerDraft() {
    draftRef.current = "";
    setDraft("");
    setCategory(null);
    composerEditorRef.current?.clear();
  }

  /** Applies any pending seed category to the composer chip once the editor is
   * available. Called from startNewTask (best-effort, the editor may not be
   * mounted yet) and again from ComposerEditor's onReady. */
  function seedComposerCategory() {
    const seed = pendingSeedCategoryRef.current;
    if (!seed) return;
    const editor = composerEditorRef.current;
    // Not mounted yet (cold open) — leave it pending for onReady to apply.
    if (!editor) return;
    pendingSeedCategoryRef.current = null;
    window.setTimeout(() => {
      if (pendingSeedCategoryRef.current) return;
      editor.setContent("", seed);
    }, 0);
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
      composerEditorRef.current?.setContent(shortcut.prompt);
      void pickAttachments();
      return;
    }
    // Prefill and select the "<placeholder>" token so typing replaces it in
    // place (setContent focuses the editor as part of selecting the range).
    composerEditorRef.current?.setContent(shortcut.prompt, null, {
      selectPlaceholder: true,
    });
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
    const activityCounts = clearSessionActivity(sessionId);
    dispatchAgentSessionStatus({
      sessionId,
      title:
        hermesSessionItems.find((session) => session.id === sessionId)?.title ??
        "Agent session",
      status: "cancelled",
      summary: "Stopped.",
      ...activityCounts,
    });

    try {
      const runtimeSessionId = runtimeSessionIds[sessionId];
      if (runtimeSessionId) {
        const gateway = await ensureHermesGateway(
          sessionUnrestricted(sessionId),
        );
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

  async function retryTask(taskId: string) {
    try {
      upsertTask(await retryAgentTask(taskId));
    } catch (err) {
      setError(messageFromError(err));
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
      const response = await hermesBridgeMessagingPlatforms();
      setMessagingPlatforms(response.platforms);
      setSelectedMessagingPlatformId((current) => {
        if (current && response.platforms.some((item) => item.id === current)) {
          return current;
        }
        return response.platforms[0]?.id;
      });
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCapabilityLoading(false);
    }
  }

  async function loadFilesystemSnapshot() {
    setFilesystemLoading(true);
    try {
      await ensureHermesGateway();
      setFilesystemSnapshot(await hermesBridgeFilesystemSnapshot());
      // No setError(null): this refires in the background on message-count
      // changes, so a success would wipe an unrelated banner (e.g. a failed
      // send). The banner is dismissable instead.
    } catch (err) {
      setError(messageFromError(err));
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
      current.map((item) =>
        item.id === sessionId ? { ...item, title } : item,
      ),
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
          selected === sessionId
            ? selectNext
              ? next[0]?.id
              : undefined
            : selected;
        selectedHermesSessionIdRef.current = nextSelected;
        return nextSelected;
      });
      return next;
    });
    scrubHermesSessionState(sessionId);
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
      setError(messageFromError(err));
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
    const firstUserMessage = messages.find(
      (message) => message.role === "user",
    );
    const prompt = firstUserMessage
      ? visibleHermesMessageText(firstUserMessage).trim()
      : "";
    if (!prompt) return;
    titleSuggestionSessionIdsRef.current.add(sessionId);
    const title = await agentSessionTitleForPrompt(prompt);
    sessionTitleOverridesRef.current = {
      ...sessionTitleOverridesRef.current,
      [sessionId]: title,
    };
    setHermesSessionItems((current) =>
      current.map((item) =>
        item.id === sessionId ? { ...item, title } : item,
      ),
    );
  }

  async function setSkillEnabled(skill: HermesSkillInfo, enabled: boolean) {
    setCapabilitySaving(`skill:${skill.name}`);
    try {
      await toggleHermesBridgeSkill({ name: skill.name, enabled });
      setSkills(
        (current) =>
          current?.map((item) =>
            item.name === skill.name ? { ...item, enabled } : item,
          ) ?? current,
      );
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCapabilitySaving(null);
    }
  }

  async function setToolsetEnabled(
    toolset: HermesToolsetInfo,
    enabled: boolean,
  ) {
    setCapabilitySaving(`toolset:${toolset.name}`);
    try {
      await toggleHermesBridgeToolset({ name: toolset.name, enabled });
      setToolsets(
        (current) =>
          current?.map((item) =>
            item.name === toolset.name ? { ...item, enabled } : item,
          ) ?? current,
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
          current?.map((item) =>
            item.id === platform.id ? { ...item, enabled } : item,
          ) ?? current,
      );
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCapabilitySaving(null);
    }
  }

  async function saveMessagingPlatformEnv(
    platform: HermesMessagingPlatformInfo,
  ) {
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
        show
          ? errors
            ? buildAgentErrorGallery()
            : buildAgentChatGallery()
          : null,
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
    ? mergeThinkingTurns(
        buildHermesSessionChatTurns(
          selectedHermesMessages,
          liveEvents[selectedHermesSessionId] ?? [],
        ),
      )
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
  const surfacedArtifacts = [...turnArtifacts.values()]
    .flat()
    .concat(devArtifacts);
  const downloadArtifact = (artifact: AgentArtifact) =>
    void downloadHermesBridgeFile(artifact.path).catch((err: unknown) =>
      setError(messageFromError(err)),
    );
  const openArtifact = (artifact: AgentArtifact) =>
    setArtifactPanel({ view: "file", artifact });

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
  const startupSessionHydrationPending =
    hermesSessionsLoading && !hermesSessionsHydrated;

  useEffect(() => {
    // The conversation scrolls in .agent-scroll, which sits below the sticky
    // breadcrumb so the scrollbar can't ride up over the bar — drive that
    // scroller to the bottom as turns arrive.
    const scroller = listRef.current?.closest(".agent-scroll");
    if (!(scroller instanceof HTMLElement)) return;
    if (typeof scroller.scrollTo !== "function") return; // jsdom has no scrollTo
    const selectionKey = `${selectedHermesSessionId ?? ""}:${selectedTaskId ?? ""}`;
    const settled = settledScrollSelectionRef.current === selectionKey;
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
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: settled ? "smooth" : "auto",
    });
  }, [
    renderedTurnsSignature,
    selectedHermesSessionId,
    selectedHistoryLoaded,
    selectedTaskId,
  ]);

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
        setHeroDeckStart(
          (start) => (start + HERO_SHORTCUT_COUNT) % AGENT_SHORTCUTS.length,
        );
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
          ) : issueReportNotice ? (
            <motion.p
              key="issue-report-notice"
              className="agent-composer-notice"
              role="status"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              {issueReportNotice}
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
                  title={attachment.name}
                >
                  {attachment.previewDataUrl ? (
                    <img
                      src={attachment.previewDataUrl}
                      alt=""
                      aria-hidden="true"
                    />
                  ) : (
                    <FileTypeIcon name={attachment.name} size={14} />
                  )}
                  <span className="agent-attachment-name">
                    {attachment.name}
                  </span>
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
          <ComposerEditor
            ref={composerEditorRef}
            placeholder={
              importingFiles
                ? "Attaching file…"
                : heroMode
                  ? "Describe a task for June…"
                  : "Send a message"
            }
            onChange={(text, nextCategory) => {
              draftRef.current = text;
              setDraft(text);
              setCategory(nextCategory);
            }}
            onSubmit={() => void submit()}
            onReady={seedComposerCategory}
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
              workingSessionIds.has(selectedHermesSessionId) ? (
                // While June works, stop owns the send slot — sending would
                // only bounce off the gateway's busy guard anyway.
                <button
                  type="button"
                  className="agent-composer-stop"
                  aria-label="Stop June"
                  title="Stop June"
                  disabled={stoppingSessionIds.has(selectedHermesSessionId)}
                  onClick={() =>
                    void stopHermesSession(selectedHermesSessionId)
                  }
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
                    (!draft.trim() && !attachments.length)
                  }
                  aria-label={
                    selectedHermesSessionId || selectedTask
                      ? "Send message"
                      : "Start session"
                  }
                >
                  {submitting ? <Spinner /> : <IconArrowUp size={16} />}
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
                <span
                  className="agent-attach-menu-icon"
                  data-category={reportCategory.key}
                >
                  <CategoryIcon category={reportCategory.key} size={16} />
                </span>
                <span className="agent-attach-menu-label">
                  {reportCategory.label}
                </span>
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
                  if (
                    option.unrestricted &&
                    !fullModeDraft &&
                    !unrestrictedAcknowledged()
                  ) {
                    setConfirmUnrestricted(true);
                    return;
                  }
                  fullModeDraftRef.current = option.unrestricted;
                  setFullModeDraft(option.unrestricted);
                }}
              >
                {option.icon}
                <span className="agent-sandbox-option">
                  <span className="agent-sandbox-option-title">
                    {option.title}
                  </span>
                  <span className="agent-sandbox-option-desc">
                    {option.description}
                  </span>
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
      {hermesTurns.map((turn) => (
        <AgentChatTurnRow
          key={turn.id}
          turn={turn}
          activeThinkingKey={activeThinkingKey}
          artifacts={turnArtifacts.get(turn.id)}
          approvalSubmitting={approvalSubmitting}
          clarifySubmitting={clarifySubmitting}
          cliAccess={{
            enabled: cliAccessEnabled,
            submitting: cliAccessSubmitting,
            onEnable: () => void enableCliAccessFromChat(),
          }}
          thinkingOpen={thinkingOpen}
          onThinkingOpenChange={setThinkingOpen}
          onDownloadArtifact={downloadArtifact}
          onOpenArtifact={openArtifact}
          onApproval={(part, choice) =>
            void respondToApproval(
              selectedHermesSessionId,
              part.sessionId ?? selectedHermesSessionId,
              part.id,
              choice,
              sessionUnrestricted(selectedHermesSessionId),
            )
          }
          onTopUp={() =>
            void osAccountsTopUp().catch((err: unknown) =>
              setError(messageFromError(err)),
            )
          }
          onClarify={(part, answer) =>
            void respondToClarify(
              selectedHermesSessionId,
              part.id,
              answer,
              sessionUnrestricted(selectedHermesSessionId),
            )
          }
        />
      ))}
      {workingSessionIds.has(selectedHermesSessionId) &&
      hermesTurns.at(-1)?.role === "user" ? (
        <AgentThinking />
      ) : null}
    </div>
  ) : !newSessionMode && selectedTask ? (
    <>
      <header className="agent-detail-header">
        <div className="agent-detail-title">
          <ActivityIndicator
            active={workingTaskIds.has(selectedTask.id)}
            large
          />
          <div className="agent-detail-heading">
            <h2>{selectedTask.title}</h2>
            <PrivacyModeBadge badge={generationPrivacyBadge} />
          </div>
        </div>
        <div className="agent-actions">
          {selectedTask.status !== "cancelled" &&
          selectedTask.status !== "completed" ? (
            <button
              type="button"
              className="agent-icon-button"
              aria-label="Cancel task"
              onClick={() => void cancelTask(selectedTask.id)}
            >
              <IconStopCircle size={15} />
            </button>
          ) : null}
          {selectedTask.status === "failed" ||
          selectedTask.status === "paused" ? (
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
            cliAccess={{
              enabled: cliAccessEnabled,
              submitting: cliAccessSubmitting,
              onEnable: () => void enableCliAccessFromChat(),
            }}
            thinkingOpen={thinkingOpen}
            onThinkingOpenChange={setThinkingOpen}
            onDownloadArtifact={downloadArtifact}
            onOpenArtifact={openArtifact}
            onTopUp={() =>
              void osAccountsTopUp().catch((err: unknown) =>
                setError(messageFromError(err)),
              )
            }
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
          />
        ))}
        {workingTaskIds.has(selectedTask.id) &&
        taskTurns.at(-1)?.role === "user" ? (
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
      {!heroMode &&
      !(!newSessionMode && !selectedHermesSessionId && selectedTask) ? (
        <AgentSessionBar
          origin={origin}
          artifactCount={!newSessionMode ? surfacedArtifacts.length : 0}
          artifactsOpen={artifactPanel !== null}
          onToggleArtifacts={() =>
            setArtifactPanel((open) => (open ? null : { view: "list" }))
          }
          privacyBadge={generationPrivacyBadge}
          // The badge describes the selected session, not the live runtime:
          // every send re-enforces the session's recorded mode, so a
          // sandboxed session stays sandboxed even while an Unrestricted
          // runtime from another session is still up. The hero composer's
          // picker covers the new-session draft.
          fullMode={
            !newSessionMode && sessionUnrestricted(selectedHermesSessionId)
          }
          title={
            !newSessionMode && selectedHermesSessionId
              ? (selectedHermesSession?.title ?? "")
              : undefined
          }
          onRename={
            !newSessionMode && selectedHermesSessionId
              ? (title) => renameHermesSession(selectedHermesSessionId, title)
              : undefined
          }
          onDelete={
            !newSessionMode && selectedHermesSessionId
              ? () => void deleteSelectedHermesSession(selectedHermesSessionId)
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
          {error ? (
            <AgentErrorBanner
              message={error}
              onRetry={
                GATEWAY_CONNECTION_ERROR.test(error)
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
                  : heroPrivacyFootnote(
                      generationModel,
                      generationPrivacyBadge,
                    )}
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
              ) : error ? (
                <AgentErrorBanner
                  message={error}
                  onRetry={
                    GATEWAY_CONNECTION_ERROR.test(error)
                      ? () => void retryGatewayConnection()
                      : undefined
                  }
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
type ComposerModelFlyout =
  | { kind: "model"; id: string }
  | { kind: "all" }
  | null;

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
    closeTimerRef.current = window.setTimeout(
      () => setCatalogHover(null),
      MODEL_HOVER_INTENT_MS,
    );
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
      return prev.top === top && prev.bottom === bottom
        ? prev
        : { top, bottom };
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
      const titlebar =
        parseFloat(getComputedStyle(el).getPropertyValue("--titlebar-h")) || 0;
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
  const selectable = options.filter(
    (option) => !option.provider || modelSupportsTools(option),
  );
  const filteredOptions = query
    ? selectable.filter((option) => modelMatchesQuery(option, query))
    : selectable;
  const detail =
    flyout?.kind === "model"
      ? suggested.find((item) => item.model.id === flyout.id)
      : undefined;

  function showCatalogHover(option: VeniceModelDto, row: HTMLElement) {
    cancelCatalogClose();
    const panel = flyoutRef.current;
    if (!panel) return;
    const rowRect = row.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const preferred = panel.dataset.side === "right" ? "right" : "left";
    const canOpenLeft =
      panelRect.left -
        MODEL_HOVERCARD_GAP -
        MODEL_HOVERCARD_W -
        MODEL_HOVERCARD_VIEWPORT_MARGIN >=
      0;
    const canOpenRight =
      panelRect.right +
        MODEL_HOVERCARD_GAP +
        MODEL_HOVERCARD_W +
        MODEL_HOVERCARD_VIEWPORT_MARGIN <=
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
      <div
        className="agent-composer-model-menu"
        role="listbox"
        aria-label="Suggested text models"
      >
        {suggested.length ? (
          suggested.map(({ model: option }) => (
            <button
              key={option.id}
              type="button"
              className="agent-composer-model-row"
              role="option"
              aria-selected={option.id === model.id}
              data-active={
                (flyout?.kind === "model" && flyout.id === option.id) ||
                undefined
              }
              onMouseEnter={() =>
                hoverIntent(() =>
                  onFlyoutChange({ kind: "model", id: option.id }),
                )
              }
              onFocus={() => {
                cancelHoverIntent();
                onFlyoutChange({ kind: "model", id: option.id });
              }}
              onClick={() => onSelect(option.id)}
            >
              <span className="agent-composer-model-row-name">
                {option.name}
              </span>
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
          <p className="agent-composer-model-empty">
            Loading suggested models.
          </p>
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
        <IconChevronRightSmall
          size={12}
          aria-hidden
          className="agent-composer-model-row-chevron"
        />
      </button>
      {detail ? (
        <div
          ref={flyoutRef}
          className="agent-composer-model-flyout agent-composer-model-detail"
        >
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
                  <p className="agent-composer-model-empty">
                    No models match your search.
                  </p>
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
            <ComposerModelCardContent
              model={catalogHover.model}
              withDescription
            />
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
  const values = [pricingLabel(model), contextLabel(model)]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <p className="agent-composer-model-detail-name">
        <span>{model.name}</span>
        {badge ? (
          <span
            className="model-trait-icon"
            data-mode={badge.mode}
            title={badge.description}
          >
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
      {values ? (
        <p className="agent-composer-model-detail-values">{values}</p>
      ) : null}
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
  onHover: (
    model: VeniceModelDto,
    row: HTMLElement,
    immediate: boolean,
  ) => void;
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
        <IconCheckmark1Small
          size={14}
          aria-hidden
          className="agent-composer-model-row-check"
        />
      ) : null}
    </button>
  );
}

function modelMatchesQuery(model: VeniceModelDto, query: string) {
  return [
    model.name,
    model.id,
    model.description,
    model.privacy,
    ...model.traits,
  ]
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
    "This session runs without the file sandbox — June can change any file your account can. Sandboxed sessions keep their jail and run alongside on a separate, jailed runtime.";
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

  const hasMenu = Boolean(onRename || onDelete);

  return (
    <div className="detail-bar agent-session-bar" data-tauri-drag-region>
      {origin ? (
        <BackButton label={origin.backLabel} onClick={origin.onBack} />
      ) : null}
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
                <button
                  type="button"
                  className="detail-breadcrumb-link"
                  onClick={crumb.onClick}
                >
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
                <span className="detail-breadcrumb-current">
                  {title || "Untitled session"}
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
              <div
                className="sidebar-identity-menu agent-session-menu"
                role="menu"
              >
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
    const response = await withTimeout(
      suggestAgentSessionTitle(prompt),
      AGENT_TITLE_TIMEOUT_MS,
    );
    return response.title.trim() || titleFromPrompt(prompt);
  } catch {
    return titleFromPrompt(prompt);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Agent title generation timed out."));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
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
      <button
        type="button"
        aria-selected={activePanel === "chat"}
        onClick={() => onChange("chat")}
      >
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
}) {
  const q = query.trim().toLowerCase();
  const visibleSkills = (skills ?? [])
    .filter((skill) => capabilityMatches(skill, q))
    .sort((a, b) => safeText(a.name).localeCompare(safeText(b.name)));
  const visibleToolsets = (toolsets ?? [])
    .filter((toolset) => capabilityMatches(toolset, q))
    .sort((a, b) =>
      safeText(a.label ?? a.name).localeCompare(safeText(b.label ?? b.name)),
    );
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
          <CapabilityGroup
            title="Skills"
            count={visibleSkills.length}
            empty="No matching skills"
          >
            {visibleSkills.map((skill) => (
              <CapabilityRow
                key={skill.name}
                title={skill.name}
                description={skill.description}
                meta={skill.category}
                enabled={Boolean(skill.enabled)}
                saving={saving === `skill:${skill.name}`}
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
                meta={
                  toolset.provider ?? toolNames(toolset).slice(0, 4).join(", ")
                }
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
    visible.find((platform) => platform.id === selectedPlatformId) ??
    visible[0] ??
    null;
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
            <CapabilityGroup
              title="Messaging"
              count={visible.length}
              empty="No matching platforms"
            >
              {visible.map((platform) => {
                const envVars = platform.envVars ?? platform.env_vars ?? [];
                const requiredSet = envVars.filter(
                  (field) => field.required && envFieldSet(field),
                ).length;
                const requiredTotal = envVars.filter(
                  (field) => field.required,
                ).length;
                const state = platform.state ?? "unknown";
                const configured =
                  platform.configured ||
                  (requiredTotal > 0 && requiredSet === requiredTotal);
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
                    <FilesystemEntryRow
                      key={entry.path}
                      entry={entry}
                      level={0}
                    />
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

function FilesystemEntryRow({
  entry,
  level,
}: {
  entry: HermesFilesystemEntry;
  level: number;
}) {
  const isDirectory = entry.kind === "directory";
  const children = entry.children ?? [];
  return (
    <div className="agent-files-entry-group">
      <div
        className="agent-files-entry"
        style={{ "--agent-file-depth": level } as CSSProperties}
      >
        <span className="agent-files-entry-icon" aria-hidden="true">
          {isDirectory ? (
            <IconFolder1 size={14} />
          ) : (
            <FileTypeIcon name={entry.name} size={14} />
          )}
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
            <FilesystemEntryRow
              key={child.path}
              entry={child}
              level={level + 1}
            />
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
  const recommended = envVars.filter(
    (field) => !field.required && !field.advanced,
  );
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
              <span>
                {platform.configured ? "Credentials set" : "Needs setup"}
              </span>
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
          <a
            className="agent-platform-docs"
            href={docsUrl}
            rel="noreferrer"
            target="_blank"
          >
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
                ? (field.redactedValue ??
                  field.redacted_value ??
                  "Replace current value")
                : (field.prompt ?? field.key)
            }
            onChange={(event) =>
              onEditEnv(field.key, event.currentTarget.value)
            }
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
      <button type="button" onClick={onSelect}>
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
          size +
          1 +
          ("text" in part && typeof part.text === "string"
            ? part.text.length
            : 0),
        0,
      ),
    0,
  );
}

// Collapse runs of "thinking-only" assistant turns (reasoning/tool, no answer
// text) into the next answer turn, so a back-to-back chain of thoughts shows as
// a single "Thought" disclosure rather than several stacked in a row.
function mergeThinkingTurns(turns: AgentChatTurn[]): AgentChatTurn[] {
  const isThinkingOnly = (turn: AgentChatTurn): boolean =>
    turn.role === "assistant" &&
    turn.parts.length > 0 &&
    turn.parts.every(
      (part) => part.type === "reasoning" || part.type === "tool",
    );
  const rebuild = (
    turn: AgentChatTurn,
    parts: AgentChatPart[],
  ): AgentChatTurn => ({
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
      pending =
        pending === undefined
          ? turn
          : rebuild(turn, [...pending.parts, ...turn.parts]);
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
  const [thinkingOpenByKey, setThinkingOpenByKey] = useState<
    Record<string, boolean>
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
          <strong>
            {errors ? "Agent error gallery" : "Agent response gallery"}
          </strong>
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
              thinkingOpen={(key) => thinkingOpenByKey[key] ?? false}
              onApproval={galleryNoop}
              onClarify={galleryNoop}
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
  cliAccess,
  thinkingOpen,
  onApproval,
  onClarify,
  onDownloadArtifact,
  onOpenArtifact,
  onThinkingOpenChange,
  onTopUp,
  turn,
}: {
  activeThinkingKey?: string;
  approvalSubmitting: Partial<Record<string, AgentApprovalChoice>>;
  artifacts?: AgentArtifact[];
  clarifySubmitting: Record<string, string>;
  /** State + handler for June's in-chat Agent CLI access request card.
   * Optional so the dev gallery can render rows without the live setting. */
  cliAccess?: AgentCliAccessCardProps;
  thinkingOpen: (key: string) => boolean;
  onApproval: (
    part: Extract<AgentChatPart, { type: "approval" }>,
    choice: AgentApprovalChoice,
  ) => void;
  onClarify: (
    part: Extract<AgentChatPart, { type: "clarify" }>,
    answer: string,
  ) => void;
  onDownloadArtifact?: (artifact: AgentArtifact) => void;
  onOpenArtifact?: (artifact: AgentArtifact) => void;
  onThinkingOpenChange: (key: string, open: boolean) => void;
  onTopUp?: () => void;
  turn: AgentChatTurn;
}) {
  const textParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "text" }> =>
      part.type === "text",
  );
  const reasoningParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "reasoning" }> =>
      part.type === "reasoning",
  );
  const toolParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "tool" }> =>
      part.type === "tool",
  );
  // Reasoning + the tool/terminal calls it made fold into one "Thinking" /
  // "Thought" disclosure so the conversation isn't littered with terminal rows.
  const thinkingRunning =
    reasoningParts.some((part) => part.status === "running") ||
    toolParts.some((part) => part.status === "running");
  const completedThinkingKey = `turn:${turn.id}:thinking`;
  const thinkingKey =
    thinkingRunning && activeThinkingKey
      ? activeThinkingKey
      : completedThinkingKey;
  const wasThinkingRunningRef = useRef(thinkingRunning);
  const carriedOpen =
    !thinkingRunning &&
    wasThinkingRunningRef.current &&
    activeThinkingKey !== undefined &&
    thinkingOpen(activeThinkingKey);
  const thinkingIsOpen = thinkingOpen(thinkingKey) || carriedOpen;

  useEffect(() => {
    const wasRunning = wasThinkingRunningRef.current;
    wasThinkingRunningRef.current = thinkingRunning;
    if (
      !wasRunning ||
      thinkingRunning ||
      activeThinkingKey === undefined ||
      reasoningParts.length + toolParts.length === 0 ||
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

  const contextParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "context" }> =>
      part.type === "context",
  );
  const nonTextParts = turn.parts.filter((part) => part.type !== "text");

  if (
    contextParts.length &&
    turn.parts.every((part) => part.type === "context")
  ) {
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
              markdown={displayedUserMessageText(part.text)}
            />
          ))}
        </div>
      </article>
    );
  }

  return (
    <article className="agent-assistant-turn" data-status={turn.status}>
      <div className="agent-assistant-turn-body">
        {reasoningParts.length > 0 || toolParts.length > 0 ? (
          <AgentThinkingGroup
            reasoning={reasoningParts}
            tools={toolParts}
            running={thinkingRunning}
            open={thinkingIsOpen}
            onOpenChange={(open) => onThinkingOpenChange(thinkingKey, open)}
          />
        ) : null}
        {turn.parts.map((part, index) =>
          part.type === "text" ? (
            hasAgentCliAccessRequest(part.text) ? (
              // June's soul emits a literal token to request the Agent CLI
              // access setting; the token renders as an approval card, never
              // as text.
              <div key={`${turn.id}:text:${index}`}>
                {stripAgentCliAccessRequest(part.text) ? (
                  <MarkdownContent
                    markdown={stripAgentCliAccessRequest(part.text)}
                    repairProse
                  />
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
          ) : part.type === "notice" ? (
            <CreditsNoticePart
              key={`${turn.id}:notice:${index}`}
              onTopUp={onTopUp}
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
        ) : null}
      </div>
    </article>
  );
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

// The raw billing failure ("Error: Error code: 402 - …") never reaches the
// transcript — the chat runtime folds it into a notice part, and this card is
// how the user learns the turn stopped and what to do about it. No title —
// icon + one sentence + the action, Claude-style.
function CreditsNoticePart({ onTopUp }: { onTopUp?: () => void }) {
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
            Add funds
          </button>
        ) : undefined
      }
    />
  );
}

function ClarifyPart({
  onClarify,
  part,
  submitting,
}: {
  onClarify: (
    part: Extract<AgentChatPart, { type: "clarify" }>,
    answer: string,
  ) => void;
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
          <p className="agent-clarify-answer">
            {part.answer.trim() ? part.answer : "Skipped"}
          </p>
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
function AgentCliAccessCard({
  cliAccess,
}: {
  cliAccess?: AgentCliAccessCardProps;
}) {
  const [dismissed, setDismissed] = useState(false);
  const enabled = cliAccess?.enabled === true;
  const resolved = enabled || dismissed;
  const busy = Boolean(cliAccess?.submitting);
  return (
    <article
      className="agent-approval-card"
      data-status={resolved ? "resolved" : "pending"}
    >
      <span className="agent-tool-icon">
        <IconConsole size={14} />
      </span>
      <div>
        <div className="agent-tool-title">
          <span>Agent CLI access requested</span>
          <span
            className="agent-tool-live-status"
            data-status={resolved ? "complete" : "running"}
          >
            {resolved ? "Resolved" : "Waiting"}
          </span>
        </div>
        <p>
          June wants write access to the state folders of your coding CLIs
          (Claude Code, Codex, Gemini, opencode) so they stay logged in and can
          save their work in sandboxed sessions. Those folders configure
          software that also runs outside June's sandbox. Enabling turns on
          "Agent CLI access" in Settings and restarts the sandboxed runtime.
        </p>
        {resolved ? (
          <p
            className="agent-approval-result"
            data-choice={enabled ? "once" : "deny"}
          >
            {enabled ? (
              <IconCheckmark1Small size={14} />
            ) : (
              <IconCrossMedium size={14} />
            )}
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
  const [explainState, setExplainState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
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
              <p
                className="agent-approval-explanation-loading"
                role="status"
                aria-live="polite"
              >
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
                June is paused because this request needs your explicit
                permission before it can continue.
              </p>
            )}
            <p>
              Approve once allows only this request. This session allows
              matching requests until the session ends.{" "}
              {part.allowPermanent
                ? "Always allows matching requests in future sessions. "
                : null}
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
  if (choice === "always")
    return pending ? "Approving permanently" : "Always approved";
  if (choice === "deny") return pending ? "Denying" : "Denied";
  return "Resolved";
}

function AgentThinkingGroup({
  open,
  onOpenChange,
  reasoning,
  tools,
  running,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reasoning: Extract<AgentChatPart, { type: "reasoning" }>[];
  tools: Extract<AgentChatPart, { type: "tool" }>[];
  running: boolean;
}) {
  // Collapsed by default to a short label — "Thinking" while it works, "Thought"
  // once done (terracotta while live). Expanding reveals the reasoning prose and
  // any terminal calls it ran, nested together.
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
        {reasoningText ? (
          <div className="agent-reasoning-text">{reasoningText}</div>
        ) : null}
        {tools.map((tool) => (
          <AgentToolPartRow key={`tool:${tool.id}`} part={tool} />
        ))}
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
      <div
        className="agent-tool-disclosure agent-tool-disclosure-static"
        data-status={status}
      >
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

function AgentToolPartRow({
  part,
}: {
  part: Extract<AgentChatPart, { type: "tool" }>;
}) {
  return (
    <AgentToolDisclosure
      name={part.name}
      status={part.status}
      text={part.text}
      statusNode={
        part.status === "running" ? (
          <span
            className="agent-tool-spinner"
            role="status"
            aria-label="Running"
            title="Running"
          >
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
          <span className="agent-artifact-size">
            {formatBytes(artifact.size)}
          </span>
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
const AGENT_FILES_WIDTH_KEY = "scribe:agent:files-panel-width";
const FILES_PANEL_MIN_W = 300;
const FILES_PANEL_MAX_W = 600;

function clampFilesPanelWidth(width: number) {
  const viewportCap =
    typeof window === "undefined"
      ? FILES_PANEL_MAX_W
      : Math.round(window.innerWidth * 0.48);
  const max = Math.max(
    FILES_PANEL_MIN_W,
    Math.min(FILES_PANEL_MAX_W, viewportCap),
  );
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
    const stored = Number.parseInt(
      window.localStorage.getItem(AGENT_FILES_WIDTH_KEY) ?? "",
      10,
    );
    if (Number.isFinite(stored)) {
      shell.style.setProperty(
        "--agent-files-w",
        `${clampFilesPanelWidth(stored)}px`,
      );
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
    const load: Promise<AgentArtifactPreview> = isPreviewableImagePath(
      artifactPath,
    )
      ? hermesBridgeFilePreview(artifactPath).then((dataUrl) =>
          dataUrl
            ? ({ kind: "image", dataUrl } as const)
            : ({ kind: "none" } as const),
        )
      : hermesBridgeFileText(artifactPath).then((text) =>
          text !== null
            ? ({ kind: "text", text } as const)
            : ({ kind: "none" } as const),
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

  const markdown =
    artifact !== null &&
    isMarkdownPath(artifact.path) &&
    preview.kind === "text";

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
  const docHighlight = artifact
    ? debouncedQuery.trim() || undefined
    : undefined;

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
          if (event.animationName === "agent-artifact-panel-in")
            setEntered(true);
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
            <h2 className="agent-artifact-panel-title">
              {artifact ? artifact.name : "Files"}
            </h2>
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
              <MarkdownContent
                markdown={preview.text}
                highlight={docHighlight}
              />
            ) : preview.kind === "text" ? (
              <pre className="agent-artifact-source">
                {docHighlight
                  ? highlightText(preview.text, docHighlight, "source")
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
                          <span className="agent-artifact-row-name">
                            {item.name}
                          </span>
                          <span className="agent-artifact-row-meta">
                            {formatBytes(item.size)}
                          </span>
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
    <div className="agent-markdown">
      {renderMarkdownBlocks(markdown, highlight, repairProse)}
    </div>
  );
}

/** Wraps case-insensitive matches of `highlight` in <mark>, leaving the text
 * untouched when there's nothing to find. Every text emission point in the
 * markdown renderer funnels through here so find-in-file can light up
 * rendered documents, not just raw source. */
function highlightText(
  text: string,
  highlight: string | undefined,
  keySeed: string,
): ReactNode[] {
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
    nodes.push(
      <mark key={`hl-${keySeed}-${count++}`}>
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    cursor = at + needle.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderMarkdownBlocks(
  markdown: string,
  highlight?: string,
  repairProse = false,
) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (!text) return;
    blocks.push(
      <p key={`p-${key++}`}>
        {renderInlineMarkdown(text, key, highlight, repairProse)}
      </p>,
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
                  <th key={cellIndex}>
                    {renderInlineMarkdown(cell, key, highlight, repairProse)}
                  </th>
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
      const content = renderInlineMarkdown(
        heading[2],
        key,
        highlight,
        repairProse,
      );
      blocks.push(
        level === 1 ? (
          <h2 key={`h-${key++}`}>{content}</h2>
        ) : (
          <h3 key={`h-${key++}`}>{content}</h3>
        ),
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
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(...markProse(text.slice(lastIndex, match.index), `g${index}`));
    }
    if (match[2]) {
      nodes.push(
        <strong key={`strong-${keySeed}-${index}`}>
          {markProse(match[2], `s${index}`)}
        </strong>,
      );
    } else if (match[3]) {
      nodes.push(
        <em key={`em-${keySeed}-${index}`}>
          {markProse(match[3], `e${index}`)}
        </em>,
      );
    } else if (match[4]) {
      nodes.push(
        <del key={`del-${keySeed}-${index}`}>
          {markProse(match[4], `d${index}`)}
        </del>,
      );
    } else if (match[5]) {
      nodes.push(
        <code key={`code-${keySeed}-${index}`}>
          {mark(match[5], `c${index}`)}
        </code>,
      );
    } else if (match[6] && match[7]) {
      nodes.push(
        <a
          key={`link-${keySeed}-${index}`}
          href={match[7]}
          rel="noreferrer"
          target="_blank"
        >
          {markProse(match[6], `a${index}`)}
        </a>,
      );
    }
    lastIndex = pattern.lastIndex;
    index += 1;
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
      key === "text" ||
        key === "delta" ||
        key === "message" ||
        key === "content",
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

function humanizeToolName(value: string) {
  return value
    .replace(/^tools?[._-]/i, "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
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
    if (
      includesQuery(entry.name, query) ||
      includesQuery(entry.path, query) ||
      children.length
    ) {
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

function promptWithAttachments(
  message: string,
  attachments: AgentAttachment[],
): string {
  if (!attachments.length) return message;
  return [
    message || "Use the attached file(s).",
    "",
    "Attached files copied into the Scribe Hermes workspace:",
    ...attachments.map(
      (attachment) =>
        `- ${attachment.name} (${attachment.rootLabel}): ${attachment.path}`,
    ),
    "",
    "Use these workspace paths when inspecting or operating on the files.",
  ].join("\n");
}

function filesystemEntriesToArtifacts(
  entries: HermesFilesystemEntry[],
  rootLabel: string,
): AgentArtifact[] {
  return entries.flatMap((entry) => {
    const children = filesystemEntriesToArtifacts(
      entry.children ?? [],
      rootLabel,
    );
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
// that happens to repeat the file name. User turns can claim a file too, but
// only by full path — that's how promptWithAttachments injects attachments,
// and a file the user just handed us shouldn't bounce back as a download.
// Name-only matches are also deduplicated by name, so two workspace copies of
// the same file don't produce twin cards.
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
      .map((part) =>
        part.type !== "context" && "text" in part ? part.text : "",
      )
      .join("\n")
      .toLowerCase();
    if (!text.trim()) continue;
    const mentioned: AgentArtifact[] = [];
    for (const artifact of artifacts) {
      const name = artifact.name.toLowerCase();
      if (!name || claimedPaths.has(artifact.path)) continue;
      const pathMentioned = text.includes(artifact.path.toLowerCase());
      const nameMentioned =
        turn.role === "assistant" &&
        !claimedNames.has(name) &&
        text.includes(name);
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
  },
) {
  const seen = new Set(fresh.map((session) => session.id));
  const retained = current.filter(
    (session) =>
      !seen.has(session.id) && shouldRetainHermesSessionId(session.id, options),
  );
  return [...fresh, ...retained].sort((a, b) =>
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
      return (
        persistedAt === undefined ||
        persistedAt >= pendingAt - PENDING_MATCH_SKEW_MS
      );
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
  const latestUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!latestUser) return false;
  const sentAt = hermesMessageTimestampMs(latestUser);
  return (
    sentAt !== undefined && Date.now() - sentAt < RESUME_ACTIVITY_WINDOW_MS
  );
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

function agentStatusFromHermesEvent(
  event: HermesGatewayEvent,
): AgentSessionStatusKind | undefined {
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
    return event.type === "approval.request"
      ? "June needs approval."
      : "June has a question.";
  }
  if (status === "completed") return "June finished.";
  if (status === "failed") return eventText(event) || "June hit a problem.";
  if (event.type === "status.update") {
    return eventText(event) || "June is working.";
  }
  if (event.type.startsWith("tool.")) {
    const payload = event.payload as Record<string, unknown> | undefined;
    const name =
      stringValue(payload?.name) ??
      stringValue(payload?.tool_name) ??
      stringValue(payload?.tool);
    return name ? `Using ${humanizeToolName(name)}.` : "Using a tool.";
  }
  if (event.type === "thinking.delta" || event.type === "reasoning.delta") {
    return "Thinking.";
  }
  return "June is working.";
}

function visibleHermesMessageText(message: HermesSessionMessage) {
  const text =
    textFromHermesValue(message.content) ??
    textFromHermesValue(message.text) ??
    "";
  return stripHermesVisibleContext(text);
}

function textFromHermesValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.trim() ? value.trim() : undefined;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => textFromHermesValue(item) ?? "").join("");
    return text.trim() ? text.trim() : undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "message", "output_text"]) {
      const text = textFromHermesValue(record[key]);
      if (text) return text;
    }
  }
  return undefined;
}

function sameVisibleMessageText(left: string, right: string) {
  return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
}

function stripHermesVisibleContext(value: string) {
  const withoutWarnings = value.replace(
    /\n*--- Context Warnings ---[\s\S]*$/m,
    "",
  );
  const marker = withoutWarnings.search(/\n*--- Attached Context ---/m);
  const visible =
    marker >= 0 ? withoutWarnings.slice(0, marker) : withoutWarnings;
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
    <span
      className="agent-activity-indicator"
      data-large={large}
      data-status={status}
    >
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
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the dropped file."));
    reader.readAsArrayBuffer(file);
  });
}

function omitRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

// Survives app restarts (localStorage, not sessionStorage): restoring an
// existing conversation after a relaunch is always safe, unlike the pending
// new-session marker, which must NOT outlive its navigation.
const AGENT_LAST_OPEN_SESSION_KEY = "scribe:agent:last-open-session";

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
    return (
      window.localStorage.getItem(AGENT_LAST_OPEN_SESSION_KEY) ?? undefined
    );
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
        ...(isReportCategory(parsed.category)
          ? { category: parsed.category }
          : {}),
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
