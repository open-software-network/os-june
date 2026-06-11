import { listen } from "@tauri-apps/api/event";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconBubbleWide } from "central-icons/IconBubbleWide";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconFolders } from "central-icons/IconFolders";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconStopCircle } from "central-icons/IconStopCircle";
import { IconToolbox } from "central-icons/IconToolbox";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { IconAnonymous } from "central-icons/IconAnonymous";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCameraSparkle } from "central-icons/IconCameraSparkle";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { IconConsoleSimple } from "central-icons/IconConsoleSimple";
import { IconWallet3 } from "central-icons/IconWallet3";
import { IconDeepSearch } from "central-icons/IconDeepSearch";
import { IconConcise } from "central-icons/IconConcise";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFiles } from "central-icons/IconFiles";
import { IconFileSparkle } from "central-icons/IconFileSparkle";
import { IconFileChart } from "central-icons/IconFileChart";
import { IconFileJpg } from "central-icons/IconFileJpg";
import { IconFilePdf } from "central-icons/IconFilePdf";
import { IconFilePng } from "central-icons/IconFilePng";
import { IconFileText } from "central-icons/IconFileText";
import { IconFileZip } from "central-icons/IconFileZip";
import { IconFolderSparkle } from "central-icons/IconFolderSparkle";
import { IconHeartBeat } from "central-icons/IconHeartBeat";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconPencil } from "central-icons/IconPencil";
import { IconPencilLine } from "central-icons/IconPencilLine";
import { IconPieChart1 } from "central-icons/IconPieChart1";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconShieldAi } from "central-icons/IconShieldAi";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { IconStop } from "central-icons/IconStop";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { IconPangolin } from "../icons/IconPangolin";
import { PangolinSpinner } from "../PangolinSpinner";
import {
  type CSSProperties,
  type FormEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BackButton } from "../ui/BackButton";
import { EmptyState } from "../ui/EmptyState";
import { InlineNotice } from "../ui/InlineNotice";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Spinner } from "../ui/Spinner";
import {
  cancelAgentTask,
  createAgentTask,
  dictationHelperCommand,
  getAgentTask,
  ensureHermesBridgeSession,
  hermesBridgeFilesystemSnapshot,
  hermesBridgeMessagingPlatforms,
  hermesBridgeFilePreview,
  hermesBridgeFileText,
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
  startHermesBridge,
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
} from "../../lib/tauri";
import {
  deleteHermesSession,
  listHermesSessionMessages,
  listHermesSessions,
  sessionTimestamp,
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
  modelPrivacyBadge,
  type ModelPrivacyBadge,
  type ProviderModelSettingsChangedDetail,
} from "../../lib/model-privacy";
import { messageFromError } from "../../lib/errors";
import {
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
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
 */
const AGENT_SHORTCUTS: AgentShortcut[] = [
  {
    key: "tidy-downloads",
    icon: <IconFolderSparkle size={18} />,
    title: "Tidy my Downloads",
    description: "Sort the clutter into folders and flag what's safe to toss.",
    prompt:
      "Tidy up my Downloads folder: group the files into subfolders by type, then list anything older than six months that looks safe to delete. Don't delete anything without checking with me first.",
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
    title: "Check my Mac's health",
    description: "Disk, memory, and login items that need attention.",
    prompt:
      "Give my Mac a quick health check: free disk space, memory pressure, login items, and anything else worth flagging. Summarize what looks fine and what needs attention.",
    action: "run",
  },
  {
    key: "find-file",
    icon: <IconMagnifyingGlass size={18} />,
    title: "Find a file",
    description: "Describe what you remember; June tracks it down.",
    prompt: "Find <a file I half-remember> on my Mac and tell me where it is.",
    action: "prefill",
  },
  {
    key: "rename-screenshots",
    icon: <IconCameraSparkle size={18} />,
    title: "Rename my screenshots",
    description: "Turn screenshot gibberish into names that mean something.",
    prompt:
      "Look through the screenshots on my Desktop and in my Downloads folder, open each one, and rename it to a short descriptive name based on what it shows. Keep the file extensions and don't overwrite anything.",
    action: "run",
  },
  {
    key: "draft-document",
    icon: <IconPencilLine size={18} />,
    title: "Draft a document",
    description: "Start a write-up and save it to your Documents.",
    prompt:
      "Draft a <kind of document> about <topic>, then save it as a Markdown file in my Documents folder.",
    action: "prefill",
  },
  {
    key: "disk-space",
    icon: <IconPieChart1 size={18} />,
    title: "Free up disk space",
    description: "Find what's eating your storage and what can go.",
    prompt:
      "Work out what's taking up the most disk space in my home folder, summarize the biggest culprits, and suggest what's safe to clean up. Don't delete anything without checking with me first.",
    action: "run",
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
    key: "find-duplicates",
    icon: <IconFiles size={18} />,
    title: "Find duplicate files",
    description: "Spot copies wasting space across your folders.",
    prompt:
      "Scan my Downloads, Documents, and Desktop folders for duplicate files, group the copies together, and tell me which ones look safe to remove. Don't delete anything without checking with me first.",
    action: "run",
  },
];

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
// agent view and back) does not re-submit a mascot reply that App still holds
// in its pendingReply state.
const handledMascotReplyIds = new Set<string>();

export function AgentWorkspace({
  initialSession,
  pendingReply,
  origin,
}: AgentWorkspaceProps = {}) {
  const initialSessionId = initialSession?.id;
  const [tasks, setTasks] = useState<AgentTaskDto[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [activePanel, setActivePanel] = useState<AgentPanel>("chat");
  const [draft, setDraft] = useState("");
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
  const [bridge, setBridge] = useState<HermesBridgeStatus>({
    running: false,
  });
  const [bridgeStarting, setBridgeStarting] = useState(false);
  // Opt-in for the session being composed in the hero: start the runtime
  // without the OS sandbox. Read through a ref inside the async submit path.
  const [fullModeDraft, setFullModeDraft] = useState(false);
  const fullModeDraftRef = useRef(false);
  const [hermesSessionItems, setHermesSessionItems] = useState<
    HermesSessionInfo[]
  >(() => (initialSession ? [initialSession] : []));
  // Mounting without an explicit target restores the last open conversation,
  // so app restarts and dev reloads land the user back in the session they
  // were working in instead of bouncing them to the newest one.
  const [selectedHermesSessionId, setSelectedHermesSessionId] = useState<
    string | undefined
  >(() => initialSessionId ?? readLastOpenSessionId());
  const selectedHermesSessionIdRef = useRef<string | undefined>(
    selectedHermesSessionId,
  );
  const lastAutoSubmittedRef = useRef<{ prompt: string; at: number }>();
  const [newSessionMode, setNewSessionMode] = useState(false);
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
  >({});
  const pendingHermesMessagesRef = useRef<
    Record<string, HermesSessionMessage[]>
  >({});
  const [hermesSessionsLoading, setHermesSessionsLoading] = useState(false);
  const [liveEvents, setLiveEvents] = useState<
    Record<string, LiveHermesEvent[]>
  >({});
  const [workingTaskIds, setWorkingTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [workingSessionIds, setWorkingSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const workingSessionIdsRef = useRef<Set<string>>(new Set());
  const [waitingSessionIds, setWaitingSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const waitingSessionIdsRef = useRef<Set<string>>(new Set());
  const [runtimeSessionIds, setRuntimeSessionIds] = useState<
    Record<string, string>
  >({});
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
  const [generationPrivacyBadge, setGenerationPrivacyBadge] =
    useState<ModelPrivacyBadge>();
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
  // Dev-tools response gallery: when set, the timeline is replaced by a labeled
  // catalog of every agent response part type. Toggled from the console via
  // window.__agentGallery() — see the effect below. The errors flag marks the
  // __agentErrors() variant, which additionally forces the chrome-level error
  // surfaces (error banner, composer busy notice) for styling.
  const [gallerySections, setGallerySections] = useState<
    AgentChatGallerySection[] | null
  >(null);
  const [galleryErrors, setGalleryErrors] = useState(false);
  const gatewayRef = useRef<HermesGatewayClient | null>(null);
  // The gateway's close listener is registered once per client instance, so
  // it routes through this ref to always run the latest render's recovery
  // closure (see recoverFromGatewayClose).
  const gatewayCloseHandlerRef = useRef(() => {});
  const gatewayRecoveringRef = useRef(false);
  // One live gateway subscription per Hermes session. A follow-up send while
  // the previous turn is still streaming must replace the old handler, not
  // stack a second one — otherwise every event lands twice in liveEvents.
  const sessionGatewayUnlistenRef = useRef<Map<string, () => void>>(new Map());
  const liveEventsRef = useRef<Record<string, LiveHermesEvent[]>>({});
  const hydratedTaskIdsRef = useRef<Set<string>>(new Set());
  // Tasks whose hydration fetch has resolved (hydratedTaskIdsRef only says
  // the fetch *started*) — the scroll-settling logic needs the landing.
  const taskHistoryLoadedIdsRef = useRef<Set<string>>(new Set());
  const newSessionModeRef = useRef(false);
  // True only while a brand-new thread is being started from the hero. The
  // hero→dock composer FLIP keys off this so it glides *only* when the empty
  // chat hands over to a fresh thread — not when the hero is dismissed by
  // selecting an existing chat from the sidebar (that should swap instantly).
  const heroExitViaThreadRef = useRef(false);
  const sessionTitleOverridesRef = useRef<Record<string, string>>({});
  const titleSuggestionSessionIdsRef = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement | null>(null);
  const agentScrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const [composerMultiline, setComposerMultiline] = useState(false);

  useEffect(() => {
    runtimeSessionIdsRef.current = runtimeSessionIds;
  }, [runtimeSessionIds]);

  useEffect(() => {
    selectedHermesSessionIdRef.current = selectedHermesSessionId;
    workingSessionIdsRef.current = workingSessionIds;
    waitingSessionIdsRef.current = waitingSessionIds;
    pendingHermesMessagesRef.current = pendingHermesMessages;
  }, [
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

  // Full mode is an opt-in made per new session, so the toggle re-arms to off
  // every time the hero is entered — it never carries over from the last one.
  useEffect(() => {
    if (!heroMode) return;
    fullModeDraftRef.current = false;
    setFullModeDraft(false);
  }, [heroMode]);

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

  const loadHermesSessions = useCallback(async () => {
    if (!bridge.running) return;
    setHermesSessionsLoading(true);
    try {
      const sessions = applySessionTitleOverrides(await listHermesSessions());
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
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setHermesSessionsLoading(false);
    }
  }, [bridge.running, selectedTask?.hermesSessionId]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    let cancelled = false;
    let requestSequence = 0;
    async function loadGenerationPrivacyBadge() {
      const requestId = ++requestSequence;
      try {
        const [settingsResponse, modelsResponse] = await Promise.all([
          providerModelSettings(),
          listVeniceModels("generation"),
        ]);
        const selectedModelId =
          settingsResponse.settings.generationModel ||
          modelsResponse.selectedModel;
        const selectedModel = modelsResponse.models.find(
          (model) => model.id === selectedModelId,
        );
        if (!cancelled && requestId === requestSequence) {
          setGenerationPrivacyBadge(
            selectedModel ? modelPrivacyBadge(selectedModel) : undefined,
          );
        }
      } catch {
        if (!cancelled && requestId === requestSequence) {
          setGenerationPrivacyBadge(undefined);
        }
      }
    }
    function handleProviderModelSettingsChanged(event: Event) {
      const { mode } = (
        event as CustomEvent<ProviderModelSettingsChangedDetail>
      ).detail;
      if (mode === "generation") {
        void loadGenerationPrivacyBadge();
      }
    }

    void loadGenerationPrivacyBadge();
    window.addEventListener(
      PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
      handleProviderModelSettingsChanged,
    );
    return () => {
      cancelled = true;
      window.removeEventListener(
        PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
        handleProviderModelSettingsChanged,
      );
    };
  }, []);

  useEffect(() => {
    if (!bridge.running) return;
    void loadHermesSessions();
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
    if (handledMascotReplyIds.has(pendingReply.requestId)) return;
    handledMascotReplyIds.add(pendingReply.requestId);
    void submitMascotReply(pendingReply);
  }, [pendingReply]);

  useEffect(() => {
    dispatchAgentSessionsChanged({
      sessions: hermesSessionItems,
      selectedSessionId: selectedHermesSessionId,
      workingSessionIds: Array.from(workingSessionIds),
      waitingSessionIds: Array.from(waitingSessionIds),
    });
  }, [
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
    gatewayCloseHandlerRef.current = () => {
      void recoverFromGatewayClose();
    };
  });

  useEffect(() => {
    function handleNewSession(event: Event) {
      const detail = (event as CustomEvent<AgentNewSessionDetail>).detail;
      void windowEventHandlersRef.current.startNewTask(detail?.prompt);
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
      void windowEventHandlersRef.current.startNewTask(pending.prompt);
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
    listHermesSessionMessages(selectedHermesSessionId)
      .then((messages) => {
        if (cancelled) return;
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
      gatewayRef.current?.close();
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

  // Auto-grow the composer with its content (capped), since WKWebView has no
  // CSS field-sizing. Recomputing on `draft` also collapses it back after a
  // submit clears the value. Runs pre-paint (layout effect) so the FLIP
  // measurements below straddle the reflow without a visible jump.
  useLayoutEffect(() => {
    const el = composerRef.current;
    const box = composerBoxRef.current;
    if (!el || !box) return;
    // FLIP "first": where things sit before this growth step reflows them.
    // On rapid typing a previous step's 160ms animation may still be in
    // flight, so these reads are mid-animation values — where the element
    // visually is right now. Cancel the stale animations afterwards so the
    // "last" measurement below is pure layout: the delta between the two then
    // starts the new glide exactly where the old one left off, instead of
    // double-applying a residual offset (jitter).
    const prevBoxHeight = box.offsetHeight;
    const prevRect = el.getBoundingClientRect();
    if (typeof el.getAnimations === "function") {
      for (const animation of el.getAnimations()) animation.cancel();
      for (const animation of box.getAnimations()) animation.cancel();
    }
    // The toolbar drops below the input once the text can't fit on one line
    // beside the buttons — so probe that at the narrow single-line width.
    // Deciding at the *current* width feeds back into itself: text that
    // overflows the narrow slot can fit on one full-width line, so the modes
    // would flip-flop on every keystroke right at the wrap boundary.
    box.dataset.multiline = "false";
    el.style.height = "auto";
    const styles = getComputedStyle(el);
    const lineHeight = parseFloat(styles.lineHeight) || 20;
    const padding =
      parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const lines = Math.round((el.scrollHeight - padding) / lineHeight);
    const multiline = lines >= 2;
    setComposerMultiline(multiline);
    // Flip the layout attribute now rather than waiting for the re-render so
    // the height below and the FLIP "last" measurement both see the final
    // layout in this same effect (none of the probe states ever paint).
    box.dataset.multiline = multiline ? "true" : "false";
    // Size to the content at the final width, never the probe width — a
    // narrow-width height on a full-width textarea leaves a phantom line.
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    const nextBoxHeight = box.offsetHeight;
    if (nextBoxHeight === prevBoxHeight) return;
    if (
      typeof box.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    // The height is already applied above; only the glide is conditional. On a
    // hero transition the composer changes shape (hero is full-width/taller),
    // but we don't want to grow-animate that: entering the hero or swapping it
    // for an existing chat should be instant, and on thread-start the hero→dock
    // FLIP below owns the box animation — running both leaves two height
    // animations fighting over the same box. prevHeroModeRef holds the prior
    // render's heroMode (the FLIP effect updates it, and runs after this one).
    if (prevHeroModeRef.current !== heroMode) return;
    // Animate the box open/closed. Its content is bottom-anchored
    // (justify-content: flex-end) and clipped (overflow: hidden), so the
    // toolbar stays pinned to the bottom edge while the top edge glides up to
    // reveal the new line.
    const grow = {
      duration: 160,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)", // --ease-out
    };
    box.animate(
      [{ height: `${prevBoxHeight}px` }, { height: `${nextBoxHeight}px` }],
      grow,
    );
    // Glide the textarea from its old spot, bottom-left anchored so the line
    // being typed stays put while space opens above it (most visible on the
    // one→two line hop, where it leaves the slot between the +/mic buttons).
    const nextRect = el.getBoundingClientRect();
    const dx = prevRect.left - nextRect.left;
    const dy = prevRect.bottom - nextRect.bottom;
    if (dx || dy) {
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0, 0)" },
        ],
        grow,
      );
    }
    // heroMode is a dependency because the hero composer is a different shape
    // (full-width textarea, taller min-height): leaving the hero must re-probe
    // the line count and clear the stale inline height, or the docked
    // composer keeps the hero's 76px textarea and multiline toolbar.
  }, [draft, attachments.length, heroMode]);

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
      composerRef.current?.focus();
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if ((!message && !attachments.length) || submitting || importingFiles)
      return;
    const content = promptWithAttachments(message, attachments);
    setSubmitting(true);
    setDraft("");
    setAttachments([]);
    try {
      await submitHermesSession(content);
      setError(null);
      setBusyNotice(null);
    } catch (err) {
      // Restore the composer so a failed send doesn't eat the message or its
      // attachments — but only where the user hasn't typed or attached
      // something new during the in-flight send.
      setDraft((current) => (current.trim() ? current : message));
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
    }
  }

  async function submitMascotReply(reply: AgentReplyDetail) {
    const message = reply.text.trim();
    if (!message) return;
    if (submitting || importingFiles) {
      // Another submission is in flight; keep the reply in the composer
      // instead of dropping it silently.
      setDraft(message);
      return;
    }
    const targetSession = reply.session;
    setActivePanel("chat");
    setSelectedTaskId(undefined);
    setDraft("");
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
      setDraft((current) => (current.trim() ? current : message));
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
    composerRef.current?.focus();
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

  async function submitHermesSession(
    content: string,
    explicitSession?: HermesSessionInfo,
  ) {
    const targetSessionId = explicitSession?.id
      ? explicitSession.id
      : newSessionModeRef.current
        ? undefined
        : selectedHermesSessionId;
    const titlePromise = targetSessionId
      ? undefined
      : agentSessionTitleForPrompt(content);
    // Only a session being created applies the Full mode opt-in; follow-ups
    // on existing sessions never change the runtime's mode under them.
    const gateway = await ensureHermesGateway(
      targetSessionId ? undefined : fullModeDraftRef.current,
    );
    const sessionTitle = titlePromise ? await titlePromise : undefined;
    const created = targetSessionId
      ? undefined
      : await gateway.request<HermesRuntimeSessionResponse>("session.create", {
          title: sessionTitle ?? titleFromPrompt(content),
          cols: 96,
        });
    const storedSessionId =
      targetSessionId ?? created?.stored_session_id ?? created?.session_id;
    if (!storedSessionId) throw new Error("Hermes did not create a session.");
    const sessionDisplayTitle =
      explicitSession?.title?.trim() ||
      explicitSession?.preview?.trim() ||
      sessionTitle ||
      titleFromPrompt(content);
    if (sessionTitle) {
      sessionTitleOverridesRef.current = {
        ...sessionTitleOverridesRef.current,
        [storedSessionId]: sessionTitle,
      };
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
        window.setTimeout(() => {
          void refreshHermesSession(storedSessionId);
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
      await loadHermesSessions();
    } catch (err) {
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

  // `fullMode` is an explicit per-new-session choice: when the running
  // runtime's mode differs, the backend restarts it (the sandbox is applied at
  // spawn and can't change on a live process). Callers acting on an existing
  // session pass undefined and reuse whatever runtime is up.
  async function ensureHermesGateway(fullMode?: boolean) {
    let current = bridge.running ? bridge : await startBridge(fullMode);
    if (
      fullMode !== undefined &&
      current.connection &&
      Boolean(current.connection.fullMode) !== fullMode
    ) {
      // Close the gateway socket before the restart kills the old process, so
      // the drop reads as intentional and doesn't trigger close-recovery.
      gatewayRef.current?.close();
      current = await startBridge(fullMode);
    }
    const wsUrl = current.connection?.wsUrl;
    if (!wsUrl) throw new Error("Hermes bridge did not return a gateway URL.");
    let gateway = gatewayRef.current;
    if (!gateway) {
      gateway = new HermesGatewayClient();
      gatewayRef.current = gateway;
      // Fires only on unexpected drops — the unmount close() detaches the
      // socket first, and a superseded socket never notifies.
      gateway.onClose(() => gatewayCloseHandlerRef.current());
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
  // their true state from persisted messages.
  async function recoverFromGatewayClose() {
    if (gatewayRecoveringRef.current) return;
    const activeSessionIds = new Set([
      ...workingSessionIdsRef.current,
      ...waitingSessionIdsRef.current,
    ]);
    if (!activeSessionIds.size) return;
    gatewayRecoveringRef.current = true;
    try {
      const gateway = await ensureHermesGateway();
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
      gatewayRecoveringRef.current = false;
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
    let rows: Array<{ id?: string; session_key?: string; status?: string }>;
    try {
      const gateway = await ensureHermesGateway();
      const response = await gateway.request<{
        sessions?: Array<{
          id?: string;
          session_key?: string;
          status?: string;
        }>;
      }>("session.active_list", {});
      rows = Array.isArray(response?.sessions) ? response.sessions : [];
    } catch {
      // Can't reach the runtime — keep the current state rather than guess.
      return;
    }
    const live = new Set<string>();
    for (const row of rows) {
      // "idle" means the runtime session exists but isn't processing a turn.
      if (!row || row.status === "idle") continue;
      if (row.session_key) live.add(String(row.session_key));
      if (row.id) live.add(String(row.id));
    }
    for (const sessionId of working) {
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

  async function refreshHermesSession(sessionId: string) {
    try {
      const messages = await listHermesSessionMessages(sessionId);
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
  ) {
    setApprovalSubmitting((current) => ({ ...current, [requestId]: choice }));
    try {
      const gateway = await ensureHermesGateway();
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
  ) {
    setClarifySubmitting((current) => ({ ...current, [requestId]: answer }));
    try {
      const gateway = await ensureHermesGateway();
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

  async function startNewTask(prompt?: string) {
    clearPendingNewSessionRequest();
    const initialPrompt = prompt?.trim() ?? "";
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
    setDraft(initialPrompt);
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
      setDraft("");
      setError(null);
    } catch (err) {
      setDraft(initialPrompt);
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
      setDraft((current) => (current.trim() ? current : prompt));
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
    setDraft(shortcut.prompt);
    if (shortcut.action === "attach") {
      void pickAttachments();
      return;
    }
    // Focus after React has flushed the draft into the textarea, selecting
    // the <placeholder> so typing replaces it in place.
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      const start = shortcut.prompt.indexOf("<");
      const end = shortcut.prompt.indexOf(">");
      if (start >= 0 && end > start) {
        el.setSelectionRange(start, end + 1);
      }
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
    try {
      const runtimeSessionId = runtimeSessionIds[sessionId];
      if (runtimeSessionId) {
        const gateway = await ensureHermesGateway();
        await gateway.request("session.interrupt", {
          session_id: runtimeSessionId,
        });
      }
    } catch {
      // Fall through to the local cleanup below.
    } finally {
      // Tear down the per-session gateway listener along with the flags —
      // a straggler "running" event arriving after the interrupt would
      // otherwise flip the session straight back to working (and on a
      // gateway drop no terminal event ever comes to unregister it).
      sessionGatewayUnlistenRef.current.get(sessionId)?.();
      const activityCounts = clearSessionActivity(sessionId);
      dispatchAgentSessionStatus({
        sessionId,
        title:
          hermesSessionItems.find((session) => session.id === sessionId)
            ?.title ?? "Agent session",
        status: "cancelled",
        summary: "Stopped.",
        ...activityCounts,
      });
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
      if (composerRef.current?.value.trim()) return;
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
  // dock when the hero hands over to a conversation — the same form stays
  // mounted, so this glide is what sells the transition instead of a teleport.
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
              <PangolinSpinner />
              {busyNotice ?? SESSION_BUSY_NOTICE}
            </motion.p>
          ) : null}
        </AnimatePresence>
        <div
          ref={composerBoxRef}
          className="agent-composer-box"
          data-dirty={draft.trim() || attachments.length ? "true" : "false"}
          data-multiline={composerMultiline ? "true" : "false"}
        >
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
                    <IconFileText size={14} />
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
          <div className="agent-composer-row">
            <button
              type="button"
              className="agent-composer-attach"
              aria-label="Attach files"
              title="Attach files"
              onClick={() => void pickAttachments()}
            >
              <IconPlusMedium size={18} />
            </button>
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder={
                importingFiles
                  ? "Attaching file…"
                  : heroMode
                    ? "Describe a task for June…"
                    : "Send a message"
              }
              rows={1}
              onKeyDown={(event) => {
                // Ignore the Enter that commits an IME composition
                // (Japanese/Chinese/Korean input) — only a real Enter
                // press should send the message.
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="agent-composer-actions">
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
                  tabIndex={draft.trim() || attachments.length ? 0 : -1}
                  aria-hidden={
                    draft.trim() || attachments.length ? undefined : true
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
          artifacts={turnArtifacts.get(turn.id)}
          approvalSubmitting={approvalSubmitting}
          clarifySubmitting={clarifySubmitting}
          onDownloadArtifact={downloadArtifact}
          onOpenArtifact={openArtifact}
          onApproval={(part, choice) =>
            void respondToApproval(
              selectedHermesSessionId,
              part.sessionId ?? selectedHermesSessionId,
              part.id,
              choice,
            )
          }
          onTopUp={() =>
            void osAccountsTopUp().catch((err: unknown) =>
              setError(messageFromError(err)),
            )
          }
          onClarify={(part, answer) =>
            void respondToClarify(selectedHermesSessionId, part.id, answer)
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
            <SafetyBadge privacyBadge={generationPrivacyBadge} />
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
            artifacts={turnArtifacts.get(turn.id)}
            approvalSubmitting={approvalSubmitting}
            clarifySubmitting={clarifySubmitting}
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
              );
            }}
            onClarify={(part, answer) =>
              void respondToClarify(selectedTask.id, part.id, answer)
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
      aria-label="Agent"
      data-artifact-panel={artifactPanel ? "open" : undefined}
      data-hero={heroMode ? "true" : undefined}
    >
      {!newSessionMode && !selectedHermesSessionId && selectedTask ? null : (
        <AgentSessionBar
          origin={origin}
          artifactCount={!newSessionMode ? surfacedArtifacts.length : 0}
          artifactsOpen={artifactPanel !== null}
          onToggleArtifacts={() =>
            setArtifactPanel((open) => (open ? null : { view: "list" }))
          }
          privacyBadge={generationPrivacyBadge}
          fullMode={Boolean(bridge.running && bridge.connection?.fullMode)}
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
      )}
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
            <h2 className="agent-hero-title">What can June do for you?</h2>
          </div>
          {composer}
          {activePanel === "chat" ? (
            <div className="agent-fullmode-row">
              <button
                type="button"
                role="switch"
                aria-checked={fullModeDraft}
                className="agent-fullmode-toggle"
                title="Start this session without the file sandbox. June can then change any file your account can. Switching modes restarts June's runtime and stops sessions that are still working."
                onClick={() => {
                  const next = !fullModeDraft;
                  fullModeDraftRef.current = next;
                  setFullModeDraft(next);
                }}
              >
                <IconShieldCrossed size={14} aria-hidden />
                Full mode
              </button>
              {fullModeDraft ? (
                <p className="agent-fullmode-hint" role="alert">
                  June won't be sandboxed and can change any file your account
                  can.
                </p>
              ) : null}
            </div>
          ) : null}
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
                {bridgeStarting
                  ? "Getting June ready…"
                  : "June runs privately on your Mac."}
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
          {artifactPanel ? (
            <AgentArtifactPanel
              artifacts={surfacedArtifacts}
              state={artifactPanel}
              onShowList={() => setArtifactPanel({ view: "list" })}
              onOpen={openArtifact}
              onDownload={downloadArtifact}
              onClose={() => setArtifactPanel(null)}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function SafetyBadge({ privacyBadge }: { privacyBadge?: ModelPrivacyBadge }) {
  if (!privacyBadge) return null;
  return (
    <span
      className="agent-safety-badge"
      data-mode={privacyBadge.mode}
      title={privacyBadge.description}
      aria-label={`${privacyBadge.label} - ${privacyBadge.description}`}
    >
      {privacyBadge.mode === "private" ? (
        <IconShieldAi size={13} aria-hidden />
      ) : (
        <IconAnonymous size={13} aria-hidden />
      )}
      <span className="agent-safety-badge-label">{privacyBadge.label}</span>
    </span>
  );
}

// Honest indicator of the live runtime, not of any one session: the jail is
// per-process, so while the user has it in Full mode every session it serves
// runs unsandboxed.
function FullModeBadge() {
  const description =
    "June is running without the file sandbox and can change any file your account can. Start a session with Full mode off to restore the sandbox.";
  return (
    <span
      className="agent-safety-badge agent-fullmode-badge"
      title={description}
      aria-label={`Full mode - ${description}`}
    >
      <IconShieldCrossed size={13} aria-hidden />
      Full mode
    </span>
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
              <span className="detail-breadcrumb-label">Agent</span>
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
        {fullMode ? <FullModeBadge /> : null}
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
        <SafetyBadge privacyBadge={privacyBadge} />
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
        <IconPangolin size={14} />
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
                    <IconPangolin size={14} />
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
          {isDirectory ? <IconFolder1 size={14} /> : <IconFileText size={14} />}
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
              onApproval={galleryNoop}
              onClarify={galleryNoop}
              onDownloadArtifact={galleryNoop}
              onTopUp={galleryNoop}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function AgentChatTurnRow({
  approvalSubmitting,
  artifacts,
  clarifySubmitting,
  onApproval,
  onClarify,
  onDownloadArtifact,
  onOpenArtifact,
  onTopUp,
  turn,
}: {
  approvalSubmitting: Partial<Record<string, AgentApprovalChoice>>;
  artifacts?: AgentArtifact[];
  clarifySubmitting: Record<string, string>;
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
  onTopUp?: () => void;
  turn: AgentChatTurn;
}) {
  const textParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "text" }> =>
      part.type === "text",
  );
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
      <article className="agent-user-turn">
        <div className="agent-user-turn-body">
          {textParts.map((part, index) => (
            <MarkdownContent
              key={`${turn.id}:text:${index}`}
              markdown={part.text}
            />
          ))}
        </div>
      </article>
    );
  }

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

  return (
    <article className="agent-assistant-turn" data-status={turn.status}>
      <div className="agent-assistant-turn-body">
        {reasoningParts.length > 0 || toolParts.length > 0 ? (
          <AgentThinkingGroup
            reasoning={reasoningParts}
            tools={toolParts}
            running={thinkingRunning}
          />
        ) : null}
        {turn.parts.map((part, index) =>
          part.type === "text" ? (
            <div key={`${turn.id}:text:${index}`}>
              <MarkdownContent markdown={part.text} />
            </div>
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
  const explanationId = useId();
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
            <p>
              June is paused because this request needs your explicit permission
              before it can continue.
            </p>
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
              onClick={() => setExplainOpen((value) => !value)}
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
  reasoning,
  tools,
  running,
}: {
  reasoning: Extract<AgentChatPart, { type: "reasoning" }>[];
  tools: Extract<AgentChatPart, { type: "tool" }>[];
  running: boolean;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // Collapsed by default to a short label — "Thinking" while it works, "Thought"
  // once done (terracotta while live). Expanding reveals the reasoning prose and
  // any terminal calls it ran, nested together.
  const open = userOpen ?? false;
  const reasoningText = reasoning
    .map((part) => part.text)
    .join("\n\n")
    .trim();
  return (
    <details
      className="agent-reasoning"
      data-status={running ? "running" : "completed"}
      open={open}
      onToggle={(event) => setUserOpen(event.currentTarget.open)}
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
            <PangolinSpinner />
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

// File-type glyphs come straight from the icon set — no hand-drawn fallbacks.
// Anything we don't have a dedicated glyph for reads as a generic text file.
const ARTIFACT_ICONS: Record<string, typeof IconFileText> = {
  pdf: IconFilePdf,
  png: IconFilePng,
  jpg: IconFileJpg,
  jpeg: IconFileJpg,
  zip: IconFileZip,
  csv: IconFileChart,
};

function artifactIcon(path: string): typeof IconFileText {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ARTIFACT_ICONS[ext] ?? IconFileText;
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
  const FileTypeIcon = artifactIcon(artifact.path);
  const summary = (
    <>
      <span className="agent-artifact-icon">
        <FileTypeIcon size={18} />
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
      <aside ref={panelRef} className="agent-artifact-panel" aria-label="Files">
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
                    const FileTypeIcon = artifactIcon(item.path);
                    return (
                      <li key={item.path}>
                        <button
                          type="button"
                          className="agent-artifact-row"
                          onClick={() => onOpen(item)}
                        >
                          <span className="agent-artifact-icon">
                            <FileTypeIcon size={18} />
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
}: {
  markdown: string;
  highlight?: string;
}) {
  return (
    <div className="agent-markdown">
      {renderMarkdownBlocks(markdown, highlight)}
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

function renderMarkdownBlocks(markdown: string, highlight?: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (!text) return;
    blocks.push(
      <p key={`p-${key++}`}>{renderInlineMarkdown(text, key, highlight)}</p>,
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
          {renderMarkdownBlocks(quoted.join("\n"), highlight)}
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
                    {renderInlineMarkdown(cell, key, highlight)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>
                      {renderInlineMarkdown(cell, key, highlight)}
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
      const content = renderInlineMarkdown(heading[2], key, highlight);
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
          {renderInlineMarkdown(item, key + itemIndex, highlight)}
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
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const mark = (value: string, slot: string) =>
    highlightText(value, highlight, `${keySeed}-${slot}`);
  const pattern =
    /(\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(...mark(text.slice(lastIndex, match.index), `g${index}`));
    }
    if (match[2]) {
      nodes.push(
        <strong key={`strong-${keySeed}-${index}`}>
          {mark(match[2], `s${index}`)}
        </strong>,
      );
    } else if (match[3]) {
      nodes.push(
        <em key={`em-${keySeed}-${index}`}>{mark(match[3], `e${index}`)}</em>,
      );
    } else if (match[4]) {
      nodes.push(
        <del key={`del-${keySeed}-${index}`}>
          {mark(match[4], `d${index}`)}
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
          {mark(match[6], `a${index}`)}
        </a>,
      );
    }
    lastIndex = pattern.lastIndex;
    index += 1;
  }
  if (lastIndex < text.length) {
    nodes.push(...mark(text.slice(lastIndex), "t"));
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
  return (
    marker >= 0 ? withoutWarnings.slice(0, marker) : withoutWarnings
  ).trim();
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

// Bottom-of-timeline "responding" affordance: the pangolin alongside a
// shimmering label, reusing the same text-shimmer the recorder uses while
// transcribing. Lives in the timeline (not the header) so it reads like the
// agent is actively composing the next turn.
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

export function markAgentNewSessionPending(prompt?: string) {
  try {
    const payload = JSON.stringify({
      createdAt: Date.now(),
      prompt: prompt?.trim() || undefined,
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
      };
      if (
        typeof parsed.createdAt !== "number" ||
        Date.now() - parsed.createdAt > AGENT_NEW_SESSION_PENDING_TTL_MS
      ) {
        return undefined;
      }
      return typeof parsed.prompt === "string" ? { prompt: parsed.prompt } : {};
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
