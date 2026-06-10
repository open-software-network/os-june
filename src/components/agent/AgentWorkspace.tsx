import {
  CheckIcon,
  CircleStopIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderTreeIcon,
  MessageSquareIcon,
  RotateCwIcon,
  ShieldCheckIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCameraSparkle } from "central-icons/IconCameraSparkle";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconConsoleSimple } from "central-icons/IconConsoleSimple";
import { IconDeepSearch } from "central-icons/IconDeepSearch";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFiles } from "central-icons/IconFiles";
import { IconFileSparkle } from "central-icons/IconFileSparkle";
import { IconFileText } from "central-icons/IconFileText";
import { IconFolderSparkle } from "central-icons/IconFolderSparkle";
import { IconHeartBeat } from "central-icons/IconHeartBeat";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconPencil } from "central-icons/IconPencil";
import { IconPencilLine } from "central-icons/IconPencilLine";
import { IconPieChart1 } from "central-icons/IconPieChart1";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconShieldAi } from "central-icons/IconShieldAi";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { IconPangolin } from "../icons/IconPangolin";
import {
  type CSSProperties,
  type FormEvent,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EmptyState } from "../ui/EmptyState";
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
  hermesBridgeSkills,
  hermesBridgeStatus,
  hermesBridgeToolsets,
  importHermesBridgeFile,
  listAgentTasks,
  downloadHermesBridgeFile,
  retryAgentTask,
  sendAgentMessage,
  startHermesBridge,
  suggestAgentSessionTitle,
  toggleHermesBridgeSkill,
  toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform,
  type AgentMessageDto,
  type AgentTaskDto,
  type AgentTaskStatus,
  type AgentToolEventDto,
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
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_SESSIONS_CHANGED_EVENT,
  dispatchAgentSessionsChanged,
  dispatchAgentSessionStatus,
  type AgentReplyDetail,
  type AgentSessionsChangedDetail,
  type AgentSessionStatusKind,
} from "../../lib/agent-events";
import {
  HermesGatewayClient,
  type HermesGatewayEvent,
} from "../../lib/hermes-gateway";
import {
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
  toolEventKey,
  type AgentApprovalChoice,
  type AgentChatPart,
  type AgentChatTurn,
  type LiveHermesEvent,
} from "../../lib/agent-chat-runtime";

const POLLED_STATUSES = new Set<AgentTaskStatus>([
  "queued",
  "running",
  "waitingForUser",
]);
const AGENT_TITLE_TIMEOUT_MS = 2500;

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
    key: "disk-space",
    icon: <IconPieChart1 size={18} />,
    title: "Free up disk space",
    description: "Find what's eating your storage and what can go.",
    prompt:
      "Work out what's taking up the most disk space in my home folder, summarize the biggest culprits, and suggest what's safe to clean up. Don't delete anything without checking with me first.",
    action: "run",
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
    key: "find-duplicates",
    icon: <IconFiles size={18} />,
    title: "Find duplicate files",
    description: "Spot copies wasting space across your folders.",
    prompt:
      "Scan my Downloads, Documents, and Desktop folders for duplicate files, group the copies together, and tell me which ones look safe to remove. Don't delete anything without checking with me first.",
    action: "run",
  },
  {
    key: "health-check",
    icon: <IconHeartBeat size={18} />,
    title: "Check my Mac's health",
    description: "Disk, memory, login items — what needs attention.",
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
    key: "research",
    icon: <IconDeepSearch size={18} />,
    title: "Research a topic",
    description: "Get a short, sourced write-up on anything.",
    prompt:
      "Research <topic> and write a short summary of what you find, with sources.",
    action: "prefill",
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
    key: "summarize-file",
    icon: <IconFileSparkle size={18} />,
    title: "Summarize a file",
    description: "Pick a document and get the key points out of it.",
    prompt:
      "Summarize the key points of the attached file and pull out any action items.",
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
];

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
  previewDataUrl?: string | null;
};

type AgentAttachment = ImportedHermesFile & {
  id: string;
};

type TauriFileDropPayload = {
  paths?: string[];
};

type HermesRuntimeSessionResponse = {
  session_id?: string;
  stored_session_id?: string;
};

type AgentWorkspaceProps = {
  initialSession?: HermesSessionInfo;
  pendingReply?: AgentReplyDetail;
};

// Module-scoped so a remount of AgentWorkspace (e.g. navigating away from the
// agent view and back) does not re-submit a mascot reply that App still holds
// in its pendingReply state.
const handledMascotReplyIds = new Set<string>();

export function AgentWorkspace({
  initialSession,
  pendingReply,
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
  const [bridge, setBridge] = useState<HermesBridgeStatus>({
    running: false,
  });
  const [bridgeStarting, setBridgeStarting] = useState(false);
  const [hermesSessionItems, setHermesSessionItems] = useState<
    HermesSessionInfo[]
  >(() => (initialSession ? [initialSession] : []));
  const [selectedHermesSessionId, setSelectedHermesSessionId] = useState<
    string | undefined
  >(initialSessionId);
  const selectedHermesSessionIdRef = useRef<string | undefined>(
    initialSessionId,
  );
  const [newSessionMode, setNewSessionMode] = useState(false);
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
  const [skills, setSkills] = useState<HermesSkillInfo[] | null>(null);
  const [toolsets, setToolsets] = useState<HermesToolsetInfo[] | null>(null);
  const [messagingPlatforms, setMessagingPlatforms] = useState<
    HermesMessagingPlatformInfo[] | null
  >(null);
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
  const [approvalSubmitting, setApprovalSubmitting] = useState<
    Partial<Record<string, AgentApprovalChoice>>
  >({});
  const [clarifySubmitting, setClarifySubmitting] = useState<
    Record<string, string>
  >({});
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
  const newSessionModeRef = useRef(false);
  const sessionTitleOverridesRef = useRef<Record<string, string>>({});
  const titleSuggestionSessionIdsRef = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [composerMultiline, setComposerMultiline] = useState(false);

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
      setError(null);
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
    }, 2500);
    return () => window.clearInterval(interval);
  }, [bridge.running, workingSessionIds]);

  // Auto-grow the composer with its content (capped), since WKWebView has no
  // CSS field-sizing. Recomputing on `draft` also collapses it back after a
  // submit clears the value.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    // Once the input wraps to a second line, the toolbar drops below it.
    const styles = getComputedStyle(el);
    const lineHeight = parseFloat(styles.lineHeight) || 20;
    const padding =
      parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const lines = Math.round((el.scrollHeight - padding) / lineHeight);
    setComposerMultiline(lines >= 2);
  }, [draft]);

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
    } catch (err) {
      // Restore the composer so a failed send doesn't eat the message or its
      // attachments — but only where the user hasn't typed or attached
      // something new during the in-flight send.
      setDraft((current) => (current.trim() ? current : message));
      setAttachments((current) => (current.length ? current : attachments));
      setError(messageFromError(err));
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
    } catch (err) {
      // Same merge-restore as submit(): don't clobber a draft the user
      // started typing while the reply was in flight.
      setDraft((current) => (current.trim() ? current : message));
      setError(messageFromError(err));
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
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => Boolean(path));
    if (!paths.length) {
      setError("Drop files from Finder to attach them to the agent.");
      return;
    }
    void importDroppedFilePaths(paths);
  }

  async function importDroppedFilePaths(paths: string[]) {
    const uniquePaths = Array.from(new Set(paths.map((path) => path.trim())))
      .filter(Boolean)
      .slice(0, 8);
    if (!uniquePaths.length) return;
    setImportingFiles(true);
    try {
      const imported = await Promise.all(
        uniquePaths.map((path) => importHermesBridgeFile(path)),
      );
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
    const gateway = await ensureHermesGateway();
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

  async function ensureHermesGateway() {
    const current = bridge.running ? bridge : await startBridge();
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

  async function startBridge() {
    setBridgeStarting(true);
    setError(null);
    try {
      const status = await startHermesBridge();
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
    newSessionModeRef.current = true;
    setNewSessionMode(true);
    setActivePanel("chat");
    setSelectedTaskId(undefined);
    selectedHermesSessionIdRef.current = undefined;
    setSelectedHermesSessionId(undefined);
    const initialPrompt = prompt?.trim() ?? "";
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

  function runShortcut(shortcut: AgentShortcut) {
    if (shortcut.action === "run") {
      void startNewTask(shortcut.prompt);
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
      setError(null);
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

  // Aggregate size of the rendered conversation so streaming deltas — which
  // grow text inside an existing turn without changing any count — still keep
  // the scroller pinned to the bottom.
  const renderedTurnsSignature = chatTurnsSignature(
    selectedHermesSessionId ? hermesTurns : taskTurns,
  );

  useEffect(() => {
    // The conversation scrolls in the main card (.main-panel-body), not an
    // inner pane — so drive that scroller to the bottom as turns arrive.
    const scroller = listRef.current?.closest(".main-panel-body");
    if (!(scroller instanceof HTMLElement)) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, [renderedTurnsSignature, selectedHermesSessionId, selectedTaskId]);

  return (
    <section className="agent-workspace" aria-label="Agent">
      {!newSessionMode && !selectedHermesSessionId && selectedTask ? null : (
        <AgentSessionBar
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
      <section className="agent-main" aria-label="Agent task details">
        {error ? <p className="error-banner">{error}</p> : null}
        {!newSessionMode && selectedHermesSessionId ? (
          <>
            <div ref={listRef} className="agent-timeline">
              {hermesTurns.map((turn) => (
                <AgentChatTurnRow
                  key={turn.id}
                  turn={turn}
                  artifacts={chatArtifacts}
                  approvalSubmitting={approvalSubmitting}
                  clarifySubmitting={clarifySubmitting}
                  onDownloadArtifact={(artifact) =>
                    void downloadHermesBridgeFile(artifact.path).catch(
                      (err: unknown) => setError(messageFromError(err)),
                    )
                  }
                  onApproval={(part, choice) =>
                    void respondToApproval(
                      selectedHermesSessionId,
                      part.sessionId ?? selectedHermesSessionId,
                      part.id,
                      choice,
                    )
                  }
                  onClarify={(part, answer) =>
                    void respondToClarify(
                      selectedHermesSessionId,
                      part.id,
                      answer,
                    )
                  }
                />
              ))}
              {workingSessionIds.has(selectedHermesSessionId) &&
              hermesTurns.at(-1)?.role === "user" ? (
                <AgentThinking />
              ) : null}
            </div>
          </>
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
                  <SafetyBadge />
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
                    <CircleStopIcon size={15} />
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
                    <RotateCwIcon size={15} />
                  </button>
                ) : null}
              </div>
            </header>
            <div ref={listRef} className="agent-timeline">
              {taskTurns.map((turn) => (
                <AgentChatTurnRow
                  key={turn.id}
                  turn={turn}
                  artifacts={chatArtifacts}
                  approvalSubmitting={approvalSubmitting}
                  clarifySubmitting={clarifySubmitting}
                  onDownloadArtifact={(artifact) =>
                    void downloadHermesBridgeFile(artifact.path).catch(
                      (err: unknown) => setError(messageFromError(err)),
                    )
                  }
                  onApproval={(part, choice) => {
                    const sessionId =
                      part.sessionId ?? selectedTask.hermesSessionId;
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
        ) : (
          <div className="agent-empty-view">
            <EmptyState
              icon={<IconPangolin size={24} />}
              title="Start an agent session"
              description={
                bridgeStarting
                  ? "Getting the agent ready…"
                  : "Pick a shortcut, or describe any desktop task in the box below. It runs privately on your machine."
              }
              label="Start an agent session"
              footer={
                <div className="agent-shortcut-grid">
                  {AGENT_SHORTCUTS.map((shortcut) => (
                    <button
                      key={shortcut.key}
                      type="button"
                      className="agent-shortcut"
                      disabled={submitting}
                      onClick={() => runShortcut(shortcut)}
                    >
                      <span className="agent-shortcut-icon" aria-hidden>
                        {shortcut.icon}
                      </span>
                      <span className="agent-shortcut-text">
                        <span className="agent-shortcut-title">
                          {shortcut.title}
                        </span>
                        <span className="agent-shortcut-description">
                          {shortcut.description}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              }
            />
          </div>
        )}

        {activePanel === "chat" ? (
          <form
            className="agent-composer"
            data-drop-active={dropActive ? "true" : undefined}
            onSubmit={(event) => void submit(event)}
            onDragOver={handleComposerDragOver}
            onDragEnter={() => setDropActive(true)}
            onDragLeave={() => setDropActive(false)}
            onDrop={handleComposerDrop}
          >
            <div
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
                        <FileIcon size={14} />
                      )}
                      <span className="agent-attachment-name">
                        {attachment.name}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${attachment.name}`}
                        onClick={() => removeAttachment(attachment.id)}
                      >
                        <XIcon size={12} />
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
                    importingFiles ? "Attaching file…" : "Send a message"
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
                    {submitting ? (
                      <Spinner size={15} />
                    ) : (
                      <IconArrowUp size={16} />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </form>
        ) : null}
      </section>
    </section>
  );
}

type TimelineItem =
  | { kind: "message"; createdAt: string; message: AgentMessageDto }
  | { kind: "tool"; createdAt: string; event: AgentToolEventDto }
  | { kind: "hermes-message"; createdAt: string; item: HermesMessageItem }
  | { kind: "hermes-note"; createdAt: string; item: HermesNoteItem }
  | { kind: "hermes-tool"; createdAt: string; item: HermesToolItem };

type HermesMessageItem = {
  id: string;
  text: string;
  status: "running" | "completed";
};

type HermesNoteItem = {
  id: string;
  label: string;
  text: string;
  status: "running" | "completed";
};

type HermesToolItem = {
  id: string;
  name: string;
  text: string;
  status: "running" | "completed" | "failed";
};

function mergeTimeline(
  messages: AgentMessageDto[],
  toolEvents: AgentToolEventDto[],
  hermesEvents: LiveHermesEvent[] = [],
): TimelineItem[] {
  return [
    ...messages.map((message) => ({
      kind: "message" as const,
      createdAt: message.createdAt,
      message,
    })),
    ...toolEvents.map((event) => ({
      kind: "tool" as const,
      createdAt: event.createdAt,
      event,
    })),
    ...normalizeHermesEvents(hermesEvents),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function normalizeHermesEvents(events: LiveHermesEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let currentMessage:
    | (HermesMessageItem & { createdAt: string; lastText?: string })
    | null = null;
  let currentNote:
    | (HermesNoteItem & { createdAt: string; lastText?: string })
    | null = null;
  const tools = new Map<
    string,
    HermesToolItem & { createdAt: string; lastText?: string }
  >();

  const flushMessage = () => {
    const message = currentMessage;
    if (!message) return;
    const text = collapseRepeatedMessageText(message.text);
    if (!text.trim()) {
      currentMessage = null;
      return;
    }
    const previous = items.at(-1);
    if (
      previous?.kind === "hermes-message" &&
      sameMessageText(previous.item.text, text)
    ) {
      previous.item.status = message.status;
      currentMessage = null;
      return;
    }
    items.push({
      kind: "hermes-message",
      createdAt: message.createdAt,
      item: {
        id: message.id,
        text,
        status: message.status,
      },
    });
    currentMessage = null;
  };

  const flushNote = () => {
    if (!currentNote?.text.trim()) {
      currentNote = null;
      return;
    }
    items.push({
      kind: "hermes-note",
      createdAt: currentNote.createdAt,
      item: {
        id: currentNote.id,
        label: currentNote.label,
        text: currentNote.text.trim(),
        status: currentNote.status,
      },
    });
    currentNote = null;
  };

  for (const event of events) {
    const text = eventText(event);
    if (event.type === "message.start") {
      flushMessage();
      currentMessage = {
        id: `message:${event.receivedAt}`,
        createdAt: event.receivedAt,
        text: "",
        status: "running",
      };
      continue;
    }
    if (event.type === "message.delta") {
      flushNote();
      if (!currentMessage) {
        currentMessage = {
          id: `message:${event.receivedAt}`,
          createdAt: event.receivedAt,
          text: "",
          status: "running",
        };
      }
      currentMessage.text = appendMessageText(currentMessage.text, text);
      currentMessage.lastText = text;
      continue;
    }
    if (event.type === "message.complete") {
      flushNote();
      if (!currentMessage) {
        currentMessage = {
          id: `message:${event.receivedAt}`,
          createdAt: event.receivedAt,
          text: "",
          status: "completed",
        };
      }
      if (text) {
        currentMessage.text = completeMessageText(currentMessage.text, text);
      }
      currentMessage.status = "completed";
      flushMessage();
      continue;
    }
    if (event.type === "thinking.delta" || event.type === "reasoning.delta") {
      flushMessage();
      if (!text || text === event.type) continue;
      const label = event.type === "thinking.delta" ? "Thinking" : "Reasoning";
      if (!currentNote || currentNote.label !== label) {
        flushNote();
        currentNote = {
          id: `${event.type}:${event.receivedAt}`,
          createdAt: event.receivedAt,
          label,
          text: "",
          status: "running",
        };
      }
      currentNote.text = appendLogText(currentNote.text, text);
      currentNote.lastText = text;
      continue;
    }
    if (event.type.startsWith("tool.")) {
      flushMessage();
      flushNote();
      const payload = event.payload as Record<string, unknown> | undefined;
      const key = toolEventKey(event);
      const status = event.type.includes("complete")
        ? "completed"
        : event.type.includes("error") || event.type.includes("fail")
          ? "failed"
          : "running";
      const name =
        stringValue(payload?.name) ??
        stringValue(payload?.tool_name) ??
        stringValue(payload?.tool) ??
        "Tool";
      const item =
        tools.get(key) ??
        ({
          id: key,
          createdAt: event.receivedAt,
          name: humanizeToolName(name),
          text: "",
          status,
        } satisfies HermesToolItem & { createdAt: string });
      item.status = status;
      item.name = humanizeToolName(name);
      if (text && text !== item.lastText) {
        item.text = appendLogText(item.text, text);
        item.lastText = text;
      }
      tools.set(key, item);
      continue;
    }
    if (event.type === "error" && text) {
      flushMessage();
      flushNote();
      items.push({
        kind: "hermes-note",
        createdAt: event.receivedAt,
        item: {
          id: `error:${event.receivedAt}`,
          label: "Error",
          text,
          status: "completed",
        },
      });
    }
  }

  flushMessage();
  flushNote();
  for (const tool of tools.values()) {
    if (!tool.text.trim()) continue;
    items.push({
      kind: "hermes-tool",
      createdAt: tool.createdAt,
      item: {
        id: tool.id,
        name: tool.name,
        text: tool.text.trim(),
        status: tool.status,
      },
    });
  }
  return items;
}

function completedHermesMessageText(events: LiveHermesEvent[]) {
  const message = normalizeHermesEvents(events)
    .filter(
      (item): item is Extract<TimelineItem, { kind: "hermes-message" }> =>
        item.kind === "hermes-message",
    )
    .at(-1);
  if (!message || message.item.status !== "completed") return "";
  return message.item.text.trim();
}

function SafetyBadge() {
  return (
    <span
      className="agent-safety-badge"
      title="Sensitive desktop, credential, payment, and destructive actions are blocked or escalated."
      aria-label="Private mode — sensitive desktop, credential, payment, and destructive actions are blocked or escalated."
    >
      <IconShieldAi size={13} aria-hidden />
      Private mode
    </span>
  );
}

// Persistent, full-width session bar — same chrome as the Notes/Folders
// breadcrumb. Stays pinned while the conversation scrolls beneath it, carries
// the private-mode badge, and folds rename/delete into an overflow menu so the
// conversation keeps the focus (no separate title heading).
function AgentSessionBar({
  title,
  onRename,
  onDelete,
}: {
  title?: string;
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
      <nav className="detail-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>
            <span className="detail-breadcrumb-label">Agent</span>
          </li>
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
          ) : null}
        </ol>
      </nav>
      <div className="detail-bar-actions">
        <SafetyBadge />
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
  return !normalized || normalized === "untitled session";
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
        <WrenchIcon size={14} />
        Skills
      </button>
      <button
        type="button"
        aria-selected={activePanel === "messaging"}
        onClick={() => onChange("messaging")}
      >
        <MessageSquareIcon size={14} />
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
          <Spinner size={16} />
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
          <Spinner size={16} />
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
          <Spinner size={16} />
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
            icon={<FolderTreeIcon size={24} />}
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
          {isDirectory ? <FolderIcon size={14} /> : <FileIcon size={14} />}
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
          icon={<MessageSquareIcon size={24} />}
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
        <RotateCwIcon size={14} />
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

function AgentChatTurnRow({
  approvalSubmitting,
  artifacts,
  clarifySubmitting,
  onApproval,
  onClarify,
  onDownloadArtifact,
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
  const mentionedArtifacts = artifactsMentionedInText(
    artifacts ?? [],
    turn.parts
      .map((part) =>
        part.type !== "context" && "text" in part ? part.text : "",
      )
      .join("\n"),
  );

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
          ) : null,
        )}
        <AgentArtifactList
          artifacts={mentionedArtifacts}
          onDownload={onDownloadArtifact}
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
        <IconPangolin size={14} />
        <span>Context compacted</span>
        <p>{part.preview}</p>
        <time>{relativeDate(createdAt)}</time>
      </summary>
      <MarkdownContent markdown={part.text} />
    </details>
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
        <MessageSquareIcon size={14} />
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
                    disabled={disabled}
                    onClick={() => onClarify(part, "")}
                  >
                    Skip
                  </button>
                  <button type="submit" disabled={disabled || !draft.trim()}>
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
  return (
    <article className="agent-approval-card" data-status={part.status}>
      <span className="agent-tool-icon">
        <ShieldCheckIcon size={14} />
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
        {resolved ? (
          <p className="agent-approval-result" data-choice={activeChoice}>
            {activeChoice === "deny" ? (
              <XIcon size={14} />
            ) : (
              <CheckIcon size={14} />
            )}
            {approvalChoiceLabel(
              activeChoice,
              part.status === "pending" && submitting !== undefined,
            )}
          </p>
        ) : (
          <div className="agent-approval-actions">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onApproval(part, "once")}
            >
              <CheckIcon size={14} />
              Approve once
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onApproval(part, "session")}
            >
              <CheckIcon size={14} />
              This session
            </button>
            {part.allowPermanent ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onApproval(part, "always")}
              >
                <CheckIcon size={14} />
                Always
              </button>
            ) : null}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onApproval(part, "deny")}
            >
              <XIcon size={14} />
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
  const summary = (
    <>
      <span className="agent-tool-icon">
        <IconConsoleSimple size={15} />
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
        {summary}
      </div>
    );
  }
  return (
    <details className="agent-tool-disclosure" data-status={status}>
      <summary>{summary}</summary>
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
          <span className="agent-tool-live-status" data-status="running">
            Running
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
}: {
  artifacts: AgentArtifact[];
  onDownload?: (artifact: AgentArtifact) => void;
}) {
  if (!artifacts.length) return null;
  return (
    <div className="agent-artifact-list" aria-label="Generated files">
      {artifacts.map((artifact) => (
        <AgentArtifactCard
          key={artifact.path}
          artifact={artifact}
          onDownload={onDownload}
        />
      ))}
    </div>
  );
}

function AgentArtifactCard({
  artifact,
  onDownload,
}: {
  artifact: AgentArtifact;
  onDownload?: (artifact: AgentArtifact) => void;
}) {
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(
    artifact.previewDataUrl ?? null,
  );

  useEffect(() => {
    let cancelled = false;
    if (artifact.previewDataUrl || !isPreviewableImagePath(artifact.path)) {
      setPreviewDataUrl(artifact.previewDataUrl ?? null);
      return;
    }
    hermesBridgeFilePreview(artifact.path)
      .then((preview) => {
        if (!cancelled) setPreviewDataUrl(preview);
      })
      .catch(() => {
        if (!cancelled) setPreviewDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.path, artifact.previewDataUrl]);

  return (
    <article
      className="agent-artifact-card"
      data-has-preview={previewDataUrl ? "true" : undefined}
    >
      {previewDataUrl ? (
        <img
          className="agent-artifact-preview"
          src={previewDataUrl}
          alt={artifact.name}
        />
      ) : (
        <span className="agent-tool-icon">
          <FileIcon size={14} />
        </span>
      )}
      <div>
        <div className="agent-artifact-title">
          <span>{artifact.name}</span>
          <em>{artifact.rootLabel}</em>
        </div>
        <p>
          {formatBytes(artifact.size)}
          <span>{compactPath(artifact.path)}</span>
        </p>
      </div>
      {onDownload ? (
        <button
          type="button"
          aria-label={`Download ${artifact.name}`}
          title="Download"
          onClick={() => onDownload(artifact)}
        >
          <DownloadIcon size={16} />
        </button>
      ) : null}
    </article>
  );
}

function MarkdownContent({ markdown }: { markdown: string }) {
  return <div className="agent-markdown">{renderMarkdownBlocks(markdown)}</div>;
}

function ToolEventRow({ event }: { event: AgentToolEventDto }) {
  return (
    <AgentToolDisclosure
      name={event.toolName.replaceAll("_", " ")}
      status={event.status}
      text={event.summary}
      redacted={event.redacted}
      statusNode={
        event.status === "completed" ? null : (
          <StatusPill status={toolStatusToTaskStatus(event.status)} compact />
        )
      }
    />
  );
}

function HermesMessageRow({ item }: { item: HermesMessageItem }) {
  return (
    <article className="agent-hermes-message" data-status={item.status}>
      <MarkdownContent markdown={item.text} />
    </article>
  );
}

function HermesToolRow({ item }: { item: HermesToolItem }) {
  return (
    <AgentToolDisclosure
      name={item.name}
      status={item.status}
      text={item.text}
      statusNode={
        item.status === "completed" ? null : (
          <StatusPill
            status={item.status === "failed" ? "failed" : "running"}
            compact
          />
        )
      }
    />
  );
}

function HermesNoteRow({ item }: { item: HermesNoteItem }) {
  const running = item.status === "running";
  const preview = item.text.replace(/\s+/g, " ").trim();
  const label = running ? item.label : preview || item.label;
  return (
    <details className="agent-hermes-note" data-status={item.status}>
      <summary>
        <span className={running ? "text-shimmer" : undefined}>{label}</span>
        <IconChevronDownSmall size={14} className="agent-disclosure-chevron" />
      </summary>
      <MarkdownContent markdown={item.text} />
    </details>
  );
}

function renderMarkdownBlocks(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (!text) return;
    blocks.push(<p key={`p-${key++}`}>{renderInlineMarkdown(text, key)}</p>);
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
      blocks.push(
        <pre key={`code-${key++}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Thematic break (---, ***, ___) → a quiet rule instead of literal dashes.
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flushParagraph();
      blocks.push(<hr key={`hr-${key++}`} className="agent-md-rule" />);
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length, 3);
      const content = renderInlineMarkdown(heading[2], key);
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
          {renderInlineMarkdown(item, key + itemIndex)}
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

function renderInlineMarkdown(text: string, keySeed: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      nodes.push(
        <strong key={`strong-${keySeed}-${index}`}>{match[2]}</strong>,
      );
    } else if (match[3]) {
      nodes.push(<code key={`code-${keySeed}-${index}`}>{match[3]}</code>);
    } else if (match[4] && match[5]) {
      nodes.push(
        <a
          key={`link-${keySeed}-${index}`}
          href={match[5]}
          rel="noreferrer"
          target="_blank"
        >
          {match[4]}
        </a>,
      );
    }
    lastIndex = pattern.lastIndex;
    index += 1;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
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

function appendMessageText(current: string, next: string) {
  if (!next.trim()) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  return `${current}${next}`;
}

function completeMessageText(current: string, complete: string) {
  if (!complete.trim()) return current;
  if (!current.trim()) return complete;
  if (complete.trim() === current.trim()) return current;
  if (complete.includes(current.trim()) || complete.length >= current.length) {
    return complete;
  }
  return appendMessageText(current, complete);
}

function collapseRepeatedMessageText(value: string) {
  let text = value.trim();
  if (!text) return "";

  for (;;) {
    const match = text.match(/^([\s\S]+?)\s+\1$/);
    if (!match?.[1]) break;
    text = match[1].trim();
  }

  const paragraphs = text.split(/\n{2,}/);
  const dedupedParagraphs = paragraphs.filter((paragraph, index) => {
    if (index === 0) return true;
    return !sameMessageText(paragraph, paragraphs[index - 1] ?? "");
  });
  text = dedupedParagraphs.join("\n\n").trim();

  const lines = text.split("\n");
  const dedupedLines = lines.filter((line, index) => {
    if (index === 0) return true;
    return !sameMessageText(line, lines[index - 1] ?? "");
  });
  text = dedupedLines.join("\n").trim();

  const half = Math.floor(text.length / 2);
  const left = text.slice(0, half).trim();
  const right = text.slice(half).trim();
  if (left && sameMessageText(left, right)) return left;

  return text;
}

function sameMessageText(left: string, right: string) {
  return normalizeMessageText(left) === normalizeMessageText(right);
}

function normalizeMessageText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function appendLogText(current: string, next: string) {
  if (!next.trim()) return current;
  if (!current) return next;
  if (current.endsWith(next)) return current;
  const separator =
    /\n$/.test(current) || /^\s/.test(next) || /^[.,!?;:]/.test(next)
      ? ""
      : "\n";
  return `${current}${separator}${next}`;
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

function artifactsMentionedInText(
  artifacts: AgentArtifact[],
  text: string,
): AgentArtifact[] {
  if (!artifacts.length || !text.trim()) return [];
  const normalized = text.toLowerCase();
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const name = artifact.name.toLowerCase();
    const path = artifact.path.toLowerCase();
    if (
      !name ||
      seen.has(artifact.path) ||
      (!normalized.includes(name) && !normalized.includes(path))
    ) {
      return false;
    }
    seen.add(artifact.path);
    return true;
  });
}

function isPreviewableImagePath(path: string) {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
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

function StatusPill({
  status,
  compact = false,
}: {
  status: AgentTaskStatus;
  compact?: boolean;
}) {
  return (
    <span
      className="agent-status-pill"
      data-status={status}
      data-compact={compact}
    >
      {statusLabel(status)}
    </span>
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

function toolStatusToTaskStatus(
  status: AgentToolEventDto["status"],
): AgentTaskStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "running" || status === "proposed") return "running";
  return "waitingForUser";
}

function isTaskActive(status: AgentTaskStatus) {
  return status === "queued" || status === "running";
}

function statusLabel(status: AgentTaskStatus) {
  switch (status) {
    case "waitingForUser":
      return "Waiting";
    default:
      return status[0].toUpperCase() + status.slice(1);
  }
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

function messageFromError(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function omitRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
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

function pendingNewSessionRequest(): AgentNewSessionDetail | undefined {
  try {
    const value = window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY);
    if (value == null) return undefined;
    try {
      const parsed = JSON.parse(value) as AgentNewSessionDetail;
      return typeof parsed.prompt === "string" ? { prompt: parsed.prompt } : {};
    } catch {
      return {};
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
