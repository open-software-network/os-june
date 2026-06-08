import {
  BotIcon,
  CheckIcon,
  CircleStopIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderTreeIcon,
  MessageSquareIcon,
  RotateCwIcon,
  SendIcon,
  ShieldCheckIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
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
  getAgentTask,
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
  saveAgentAssistantMessage,
  saveAgentHermesSession,
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
  listHermesSessionMessages,
  listHermesSessions,
  sessionTimestamp,
  titleFromPrompt,
} from "../../lib/hermes-adapter";
import {
  HermesGatewayClient,
  type HermesGatewayEvent,
} from "../../lib/hermes-gateway";
import {
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
  completedHermesMessageText as completedHermesRuntimeMessageText,
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

export const AGENT_NEW_SESSION_EVENT = "scribe:agent:new-session";
export const AGENT_DELETE_SESSION_EVENT = "scribe:agent:delete-session";
export const AGENT_SESSIONS_CHANGED_EVENT = "scribe:agent:sessions-changed";
export const AGENT_NEW_SESSION_PENDING_KEY = "scribe:agent:new-session-pending";

export type AgentSessionsChangedDetail = {
  sessions: HermesSessionInfo[];
  selectedSessionId?: string;
  workingSessionIds: string[];
};

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
};

export function AgentWorkspace({ initialSession }: AgentWorkspaceProps = {}) {
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
  const [hermesSessions, setHermesSessions] = useState<Record<string, string>>(
    {},
  );
  const [hermesSessionItems, setHermesSessionItems] = useState<
    HermesSessionInfo[]
  >(() => (initialSession ? [initialSession] : []));
  const [selectedHermesSessionId, setSelectedHermesSessionId] = useState<
    string | undefined
  >(initialSessionId);
  const [newSessionMode, setNewSessionMode] = useState(false);
  const [hermesSessionMessages, setHermesSessionMessages] = useState<
    Record<string, HermesSessionMessage[]>
  >({});
  const [pendingHermesMessages, setPendingHermesMessages] = useState<
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
  const liveEventsRef = useRef<Record<string, LiveHermesEvent[]>>({});
  const hydratedTaskIdsRef = useRef<Set<string>>(new Set());
  const newSessionModeRef = useRef(false);
  const sessionTitleOverridesRef = useRef<Record<string, string>>({});
  const titleSuggestionSessionIdsRef = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement | null>(null);

  const setTaskWorking = useCallback((taskId: string, working: boolean) => {
    setWorkingTaskIds((current) => {
      const next = new Set(current);
      if (working) {
        next.add(taskId);
      } else {
        next.delete(taskId);
      }
      return next;
    });
  }, []);

  const setSessionWorking = useCallback(
    (sessionId: string, working: boolean) => {
      setWorkingSessionIds((current) => {
        const next = new Set(current);
        if (working) {
          next.add(sessionId);
        } else {
          next.delete(sessionId);
        }
        return next;
      });
    },
    [],
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

  const upsertTask = useCallback((task: AgentTaskDto) => {
    setTasks((prev) => {
      const rest = prev.filter((item) => item.id !== task.id);
      return [task, ...rest].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    });
    setSelectedTaskId(task.id);
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
      setHermesSessionItems(sessions);
      setSelectedHermesSessionId((current) => {
        if (newSessionModeRef.current) return undefined;
        if (current && sessions.some((session) => session.id === current)) {
          return current;
        }
        const taskSession = selectedTask?.hermesSessionId;
        if (
          taskSession &&
          sessions.some((session) => session.id === taskSession)
        ) {
          return taskSession;
        }
        return sessions[0]?.id;
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
    window.dispatchEvent(
      new CustomEvent<AgentSessionsChangedDetail>(
        AGENT_SESSIONS_CHANGED_EVENT,
        {
          detail: {
            sessions: hermesSessionItems,
            selectedSessionId: selectedHermesSessionId,
            workingSessionIds: Array.from(workingSessionIds),
          },
        },
      ),
    );
  }, [hermesSessionItems, selectedHermesSessionId, workingSessionIds]);

  useEffect(() => {
    function handleNewSession(event: Event) {
      const detail = (event as CustomEvent<AgentNewSessionDetail>).detail;
      void startNewTask(detail?.prompt);
    }

    function handleDeleteSession(event: Event) {
      const detail = (event as CustomEvent<AgentDeleteSessionDetail>).detail;
      if (!detail?.sessionId) return;
      const { sessionId } = detail;
      setHermesSessionItems((current) => {
        const next = current.filter((session) => session.id !== sessionId);
        setSelectedHermesSessionId((selected) =>
          selected === sessionId ? next[0]?.id : selected,
        );
        return next;
      });
      setHermesSessionMessages((current) => omitRecordKey(current, sessionId));
      setPendingHermesMessages((current) => omitRecordKey(current, sessionId));
      setWorkingSessionIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
      liveEventsRef.current = omitRecordKey(liveEventsRef.current, sessionId);
      setLiveEvents(liveEventsRef.current);
    }

    const pending = pendingNewSessionRequest();
    if (pending) {
      void startNewTask(pending.prompt);
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
        setHermesSessionMessages((current) => ({
          ...current,
          [selectedHermesSessionId]: messages,
        }));
        setPendingHermesMessages((current) => ({
          ...current,
          [selectedHermesSessionId]: retainUnpersistedPendingMessages(
            current[selectedHermesSessionId] ?? [],
            messages,
          ),
        }));
        void suggestTitleForUntitledSession(selectedHermesSessionId, messages);
        if (sessionHasAssistantAfterLatestUser(messages)) {
          setSessionWorking(selectedHermesSessionId, false);
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

  useEffect(() => {
    if (
      !bridge.running ||
      !selectedHermesSessionId ||
      !workingSessionIds.has(selectedHermesSessionId)
    )
      return;
    const sessionId = selectedHermesSessionId;
    const interval = window.setInterval(() => {
      void refreshHermesSession(sessionId);
    }, 2500);
    return () => window.clearInterval(interval);
  }, [bridge.running, selectedHermesSessionId, workingSessionIds]);

  useEffect(() => {
    if (typeof listRef.current?.scrollTo !== "function") return;
    listRef.current.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [
    selectedTask?.messages.length,
    selectedTask?.toolEvents.length,
    selectedHermesMessages.length,
    selectedHermesSessionId,
  ]);

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if ((!message && !attachments.length) || submitting || importingFiles)
      return;
    const content = promptWithAttachments(message, attachments);
    setSubmitting(true);
    setDraft("");
    try {
      await submitHermesSession(content);
      setAttachments([]);
      setError(null);
    } catch (err) {
      setDraft(message);
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

  async function submitHermesSession(content: string) {
    const titlePromise = selectedHermesSessionId
      ? undefined
      : agentSessionTitleForPrompt(content);
    const gateway = await ensureHermesGateway();
    const sessionTitle = titlePromise ? await titlePromise : undefined;
    const created = selectedHermesSessionId
      ? undefined
      : await gateway.request<HermesRuntimeSessionResponse>("session.create", {
          title: sessionTitle ?? titleFromPrompt(content),
          cols: 96,
        });
    const storedSessionId =
      selectedHermesSessionId ??
      created?.stored_session_id ??
      created?.session_id;
    if (!storedSessionId) throw new Error("Hermes did not create a session.");
    if (sessionTitle) {
      sessionTitleOverridesRef.current = {
        ...sessionTitleOverridesRef.current,
        [storedSessionId]: sessionTitle,
      };
    }
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
    setSelectedHermesSessionId(storedSessionId);
    setSelectedTaskId(undefined);
    setHermesSessionItems((current) => {
      if (current.some((session) => session.id === storedSessionId))
        return current;
      return [
        {
          id: storedSessionId,
          title: sessionTitle ?? titleFromPrompt(content),
          preview: content,
          started_at: createdAt,
          last_active: createdAt,
          message_count: 1,
        },
        ...current,
      ];
    });
    setPendingHermesMessages((current) => ({
      ...current,
      [storedSessionId]: [
        ...(current[storedSessionId] ?? []),
        {
          id: `pending:user:${Date.now()}`,
          role: "user",
          content,
          timestamp: createdAt,
        },
      ],
    }));
    setSessionWorking(storedSessionId, true);
    const unlisten = gateway.onEvent((event) => {
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
      if (isTerminalHermesEvent(event.type)) {
        unlisten();
        setSessionWorking(storedSessionId, false);
        window.setTimeout(() => {
          void refreshHermesSession(storedSessionId);
        }, 300);
      }
    });
    try {
      await gateway.request("prompt.submit", {
        session_id: runtimeSessionId,
        text: content,
      });
      await loadHermesSessions();
    } catch (err) {
      unlisten();
      setSessionWorking(storedSessionId, false);
      throw err;
    }
  }

  async function ensureHermesGateway() {
    const current = bridge.running ? bridge : await startBridge();
    const wsUrl = current.connection?.wsUrl;
    if (!wsUrl) throw new Error("Hermes bridge did not return a gateway URL.");
    const gateway = gatewayRef.current ?? new HermesGatewayClient();
    gatewayRef.current = gateway;
    await gateway.connect(wsUrl);
    return gateway;
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

  async function submitToHermes(task: AgentTaskDto, content: string) {
    try {
      const gateway = await ensureHermesGateway();
      const existingSessionId = task.hermesSessionId ?? hermesSessions[task.id];
      const sessionId =
        existingSessionId ??
        (
          await gateway.request<HermesRuntimeSessionResponse>(
            "session.create",
            {
              title: task.title,
              cols: 100,
            },
          )
        ).session_id;
      if (!sessionId) throw new Error("Hermes did not create a session.");
      setHermesSessions((prev) => ({ ...prev, [task.id]: sessionId }));
      setTaskWorking(task.id, true);
      if (sessionId !== task.hermesSessionId) {
        saveAgentHermesSession({
          taskId: task.id,
          hermesSessionId: sessionId,
        })
          .then(upsertTask)
          .catch((err: unknown) => setError(messageFromError(err)));
      }
      const unlisten = gateway.onEvent((event) => {
        if (event.session_id !== sessionId) return;
        const liveEvent = { ...event, receivedAt: new Date().toISOString() };
        const nextTaskEvents = [
          ...(liveEventsRef.current[task.id] ?? []),
          liveEvent,
        ].slice(-200);
        liveEventsRef.current = {
          ...liveEventsRef.current,
          [task.id]: nextTaskEvents,
        };
        setLiveEvents(liveEventsRef.current);
        if (isTerminalHermesEvent(event.type)) {
          unlisten();
          setTaskWorking(task.id, false);
          const completedText =
            completedHermesRuntimeMessageText(nextTaskEvents);
          if (completedText) {
            void persistHermesAssistantMessage(task.id, completedText);
          }
        }
      });
      await gateway.request("prompt.submit", {
        session_id: sessionId,
        text: content,
      });
    } catch (err) {
      setTaskWorking(task.id, false);
      setError(messageFromError(err));
    }
  }

  async function persistHermesAssistantMessage(
    taskId: string,
    content: string,
  ) {
    try {
      const savedTask = await saveAgentAssistantMessage({ taskId, content });
      liveEventsRef.current = { ...liveEventsRef.current, [taskId]: [] };
      setLiveEvents(liveEventsRef.current);
      upsertTask(savedTask);
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function refreshHermesSession(sessionId: string) {
    try {
      const messages = await listHermesSessionMessages(sessionId);
      setHermesSessionMessages((current) => ({
        ...current,
        [sessionId]: messages,
      }));
      setPendingHermesMessages((current) => ({
        ...current,
        [sessionId]: retainUnpersistedPendingMessages(
          current[sessionId] ?? [],
          messages,
        ),
      }));
      void suggestTitleForUntitledSession(sessionId, messages);
      if (sessionHasAssistantAfterLatestUser(messages)) {
        setSessionWorking(sessionId, false);
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
        setWorkingTaskIds(new Set());
        setWorkingSessionIds(new Set());
        liveEventsRef.current = {};
        setLiveEvents({});
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
    setSelectedHermesSessionId(undefined);
    const initialPrompt = prompt?.trim() ?? "";
    setDraft(initialPrompt);
    if (!initialPrompt) return;
    setSubmitting(true);
    try {
      await submitHermesSession(initialPrompt);
      setDraft("");
      setError(null);
    } catch (err) {
      setDraft(initialPrompt);
      setError(messageFromError(err));
    } finally {
      setSubmitting(false);
    }
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

  return (
    <section className="agent-workspace" aria-label="Agent">
      <section className="agent-main" aria-label="Agent task details">
        {error ? <p className="error-banner">{error}</p> : null}
        {!newSessionMode && selectedHermesSessionId ? (
          <>
            <header className="agent-detail-header">
              <div className="agent-detail-title">
                <ActivityIndicator
                  active={workingSessionIds.has(selectedHermesSessionId)}
                  large
                />
                <div>
                  <h2>
                    {selectedHermesSession?.title ||
                      selectedHermesSession?.preview ||
                      "Untitled session"}
                  </h2>
                </div>
              </div>
            </header>
            <div ref={listRef} className="agent-timeline">
              <SafetyPanel />
              {buildHermesSessionChatTurns(
                selectedHermesMessages,
                liveEvents[selectedHermesSessionId] ?? [],
              ).map((turn) => (
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
                <div>
                  <h2>{selectedTask.title}</h2>
                  {workingTaskIds.has(selectedTask.id) ? (
                    <p>Working now.</p>
                  ) : null}
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
              <SafetyPanel />
              {buildAgentChatTurns(
                selectedTask.messages,
                selectedTask.toolEvents,
                liveEvents[selectedTask.id] ?? [],
              ).map((turn) => (
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
                      part.sessionId ??
                      selectedTask.hermesSessionId ??
                      hermesSessions[selectedTask.id];
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
            </div>
          </>
        ) : (
          <>
            <header className="agent-detail-header">
              <div className="agent-detail-title">
                <BotIcon size={18} />
                <div>
                  <h2>Agent</h2>
                  <p>
                    {bridgeStarting
                      ? "Setting up the local agent runtime..."
                      : bridge.running
                        ? `Hermes bridge running on ${bridge.connection?.port ?? "local"}`
                        : "Desktop tasks with private local-tool policy."}
                  </p>
                </div>
              </div>
            </header>
            <div className="agent-compose-empty">
              <EmptyState
                icon={<BotIcon size={24} />}
                title="Start an agent session"
                description="Use New Session in the sidebar, then ask the agent to complete a desktop task."
                label="Start an agent session"
              />
            </div>
          </>
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
            <div className="agent-composer-input">
              {attachments.length ? (
                <div className="agent-attachment-list" aria-label="Attachments">
                  {attachments.map((attachment) => (
                    <div key={attachment.id} className="agent-attachment-chip">
                      {attachment.previewDataUrl ? (
                        <img
                          src={attachment.previewDataUrl}
                          alt=""
                          aria-hidden="true"
                        />
                      ) : (
                        <FileIcon size={15} />
                      )}
                      <span>{attachment.name}</span>
                      <em>{attachment.rootLabel}</em>
                      <button
                        type="button"
                        aria-label={`Remove ${attachment.name}`}
                        onClick={() => removeAttachment(attachment.id)}
                      >
                        <XIcon size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                placeholder={
                  importingFiles
                    ? "Attaching file..."
                    : selectedHermesSessionId || selectedTask
                      ? "Send a follow-up"
                      : "Ask the agent to complete a desktop task"
                }
                rows={2}
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            </div>
            <button
              type="submit"
              disabled={
                submitting ||
                importingFiles ||
                (!draft.trim() && !attachments.length)
              }
            >
              {submitting ? <Spinner size={15} /> : <SendIcon size={15} />}
              <span>
                {selectedHermesSessionId || selectedTask ? "Send" : "Create"}
              </span>
            </button>
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

function SafetyPanel() {
  return (
    <section className="agent-safety-panel" aria-label="Agent safety policy">
      <ShieldCheckIcon size={16} />
      <div>
        <h3>Autonomous private mode</h3>
        <p>
          Local actions are audited. Sensitive desktop, credential, payment, and
          destructive actions are blocked or escalated before execution.
        </p>
      </div>
    </section>
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
        <BotIcon size={14} />
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
                    <BotIcon size={14} />
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

function MessageBubble({ message }: { message: AgentMessageDto }) {
  return (
    <article className="agent-message" data-role={message.role}>
      <div className="agent-message-meta">
        {message.role === "assistant" ? "Agent" : "You"}
        <span>{relativeDate(message.createdAt)}</span>
      </div>
      <MarkdownContent markdown={message.content} />
    </article>
  );
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
  const nonTextParts = turn.parts.filter((part) => part.type !== "text");
  const mentionedArtifacts = artifactsMentionedInText(
    artifacts ?? [],
    turn.parts.map((part) => ("text" in part ? part.text : "")).join("\n"),
  );

  if (turn.role === "user") {
    return (
      <article className="agent-message" data-role="user">
        <div className="agent-message-meta">
          You
          <span>{relativeDate(turn.createdAt)}</span>
        </div>
        {textParts.map((part, index) => (
          <MarkdownContent
            key={`${turn.id}:text:${index}`}
            markdown={part.text}
          />
        ))}
      </article>
    );
  }

  return (
    <article className="agent-assistant-turn" data-status={turn.status}>
      <div className="agent-assistant-turn-meta">
        Agent
        <span>{relativeDate(turn.createdAt)}</span>
      </div>
      <div className="agent-assistant-turn-body">
        {turn.parts.map((part, index) =>
          part.type === "text" ? (
            <div key={`${turn.id}:text:${index}`}>
              <MarkdownContent markdown={part.text} />
            </div>
          ) : part.type === "reasoning" ? (
            <ReasoningPart key={`${turn.id}:reasoning:${index}`} part={part} />
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
          ) : (
            <AgentToolPartRow key={`${turn.id}:tool:${part.id}`} part={part} />
          ),
        )}
        <AgentArtifactList
          artifacts={mentionedArtifacts}
          onDownload={onDownloadArtifact}
        />
        {textParts.length === 0 && nonTextParts.length === 0 ? (
          <p className="agent-assistant-empty">Waiting for Hermes...</p>
        ) : null}
      </div>
    </article>
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

function ReasoningPart({
  part,
}: {
  part: Extract<AgentChatPart, { type: "reasoning" }>;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? part.status === "running";
  const preview = part.text.replace(/\s+/g, " ").trim();
  return (
    <details
      className="agent-reasoning"
      data-status={part.status}
      open={open}
      onToggle={(event) => setUserOpen(event.currentTarget.open)}
    >
      <summary>
        <BotIcon size={14} />
        <span>Thinking</span>
        <p>{preview}</p>
      </summary>
      <div className="agent-reasoning-body">{part.text}</div>
    </details>
  );
}

function AgentToolPartRow({
  part,
}: {
  part: Extract<AgentChatPart, { type: "tool" }>;
}) {
  return (
    <article className="agent-hermes-event" data-status={part.status}>
      <span className="agent-tool-icon">
        <TerminalIcon size={14} />
      </span>
      <div>
        <div className="agent-tool-title">
          <span>{part.name}</span>
          <span className="agent-tool-live-status" data-status={part.status}>
            {part.status === "running"
              ? "Running"
              : part.status === "failed"
                ? "Failed"
                : "Done"}
          </span>
        </div>
        {part.text ? <p>{part.text}</p> : null}
      </div>
    </article>
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
    <article className="agent-tool-event" data-status={event.status}>
      <span className="agent-tool-icon">
        <TerminalIcon size={14} />
      </span>
      <div>
        <div className="agent-tool-title">
          <span>{event.toolName.replaceAll("_", " ")}</span>
          <StatusPill status={toolStatusToTaskStatus(event.status)} compact />
        </div>
        <p>{event.summary}</p>
        {event.redacted ? (
          <span className="agent-redacted">Redacted</span>
        ) : null}
      </div>
    </article>
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
    <article className="agent-hermes-event" data-status={item.status}>
      <span className="agent-tool-icon">
        <TerminalIcon size={14} />
      </span>
      <div>
        <div className="agent-tool-title">
          <span>{item.name}</span>
          <StatusPill
            status={
              item.status === "completed"
                ? "completed"
                : item.status === "failed"
                  ? "failed"
                  : "running"
            }
            compact
          />
        </div>
        <p>{item.text}</p>
      </div>
    </article>
  );
}

function HermesNoteRow({ item }: { item: HermesNoteItem }) {
  return (
    <details className="agent-hermes-note" data-status={item.status}>
      <summary>
        <BotIcon size={14} />
        <span>{item.label}</span>
        <p>{item.text}</p>
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

function toolEventKey(event: HermesGatewayEvent) {
  const payload = event.payload as Record<string, unknown> | undefined;
  return (
    stringValue(payload?.id) ??
    stringValue(payload?.call_id) ??
    stringValue(payload?.tool_call_id) ??
    stringValue(payload?.name) ??
    `tool:${event.type}:${(event as LiveHermesEvent).receivedAt}`
  );
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

function retainUnpersistedPendingMessages(
  pending: HermesSessionMessage[],
  persisted: HermesSessionMessage[],
) {
  return pending.filter(
    (pendingMessage) =>
      !persisted.some(
        (message) =>
          message.role === pendingMessage.role &&
          sameVisibleMessageText(
            visibleHermesMessageText(message),
            visibleHermesMessageText(pendingMessage),
          ),
      ),
  );
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
}: {
  active: boolean;
  large?: boolean;
}) {
  if (!active) return null;
  return (
    <span className="agent-activity-indicator" data-large={large}>
      <span aria-hidden="true" />
      Working
    </span>
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
