import {
  BotIcon,
  CircleStopIcon,
  MessageSquareIcon,
  RotateCwIcon,
  SendIcon,
  ShieldCheckIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import {
  type FormEvent,
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
  hermesBridgeMessagingPlatforms,
  hermesBridgeSkills,
  hermesBridgeStatus,
  hermesBridgeToolsets,
  listAgentTasks,
  retryAgentTask,
  saveAgentAssistantMessage,
  saveAgentHermesSession,
  sendAgentMessage,
  startHermesBridge,
  toggleHermesBridgeSkill,
  toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform,
  type AgentMessageDto,
  type AgentTaskDto,
  type AgentTaskStatus,
  type AgentToolEventDto,
  type HermesMessagingEnvVarInfo,
  type HermesMessagingPlatformInfo,
  type HermesSessionCreateResponse,
  type HermesSessionInfo,
  type HermesSessionMessage,
  type HermesSkillInfo,
  type HermesToolsetInfo,
  type HermesBridgeStatus,
} from "../../lib/tauri";
import {
  createHermesSession,
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
  type AgentChatPart,
  type AgentChatTurn,
  type LiveHermesEvent,
} from "../../lib/agent-chat-runtime";

const POLLED_STATUSES = new Set<AgentTaskStatus>([
  "queued",
  "running",
  "waitingForUser",
]);

type AgentPanel = "chat" | "skills" | "messaging";

export function AgentWorkspace() {
  const [tasks, setTasks] = useState<AgentTaskDto[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [activePanel, setActivePanel] = useState<AgentPanel>("chat");
  const [draft, setDraft] = useState("");
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
  >([]);
  const [selectedHermesSessionId, setSelectedHermesSessionId] =
    useState<string>();
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
  const gatewayRef = useRef<HermesGatewayClient | null>(null);
  const liveEventsRef = useRef<Record<string, LiveHermesEvent[]>>({});
  const hydratedTaskIdsRef = useRef<Set<string>>(new Set());
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
      setSelectedTaskId((current) => current ?? response.items[0]?.id);
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
      const sessions = await listHermesSessions();
      setHermesSessionItems(sessions);
      setSelectedHermesSessionId((current) => {
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
          [selectedHermesSessionId]: [],
        }));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageFromError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge.running, selectedHermesSessionId]);

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
    listRef.current?.scrollTo({
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
    if (activePanel === "skills" && (!skills || !toolsets)) {
      void loadCapabilities();
    }
    if (activePanel === "messaging" && !messagingPlatforms) {
      void loadMessagingPlatforms();
    }
  }, [activePanel]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || submitting) return;
    setSubmitting(true);
    setDraft("");
    try {
      await submitHermesSession(content);
      setError(null);
    } catch (err) {
      setDraft(content);
      setError(messageFromError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitHermesSession(content: string) {
    const gateway = await ensureHermesGateway();
    const createdSession = selectedHermesSessionId
      ? undefined
      : await createHermesSession(titleFromPrompt(content));
    const sessionId = selectedHermesSessionId ?? createdSession?.id;
    if (!sessionId) throw new Error("Hermes did not create a session.");
    const createdAt = new Date().toISOString();
    setSelectedHermesSessionId(sessionId);
    setSelectedTaskId(undefined);
    setHermesSessionItems((current) => {
      if (current.some((session) => session.id === sessionId)) return current;
      return [
        {
          id: sessionId,
          title: createdSession?.title ?? titleFromPrompt(content),
          preview: content,
          started_at: createdSession?.started_at ?? createdAt,
          last_active: createdSession?.last_active ?? createdAt,
          message_count: 1,
        },
        ...current,
      ];
    });
    setPendingHermesMessages((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
        {
          id: `pending:user:${Date.now()}`,
          role: "user",
          content,
          timestamp: createdAt,
        },
      ],
    }));
    setSessionWorking(sessionId, true);
    const unlisten = gateway.onEvent((event) => {
      if (event.session_id !== sessionId) return;
      const liveEvent = { ...event, receivedAt: new Date().toISOString() };
      const nextSessionEvents = [
        ...(liveEventsRef.current[sessionId] ?? []),
        liveEvent,
      ].slice(-200);
      liveEventsRef.current = {
        ...liveEventsRef.current,
        [sessionId]: nextSessionEvents,
      };
      setLiveEvents(liveEventsRef.current);
      if (event.type === "message.complete") {
        unlisten();
        setSessionWorking(sessionId, false);
        window.setTimeout(() => {
          void refreshHermesSession(sessionId);
        }, 300);
      } else if (event.type === "error") {
        unlisten();
        setSessionWorking(sessionId, false);
      }
    });
    try {
      await gateway.request("prompt.submit", {
        session_id: sessionId,
        text: content,
      });
      await loadHermesSessions();
    } catch (err) {
      unlisten();
      setSessionWorking(sessionId, false);
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
    try {
      const status = await startHermesBridge();
      setBridge(status);
      return status;
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
          await gateway.request<HermesSessionCreateResponse>("session.create", {
            title: task.title,
            cols: 100,
          })
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
        if (event.type === "message.complete") {
          unlisten();
          setTaskWorking(task.id, false);
          const completedText =
            completedHermesRuntimeMessageText(nextTaskEvents);
          if (completedText) {
            void persistHermesAssistantMessage(task.id, completedText);
          }
        } else if (event.type === "error") {
          setTaskWorking(task.id, false);
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
      setPendingHermesMessages((current) => ({ ...current, [sessionId]: [] }));
      liveEventsRef.current = { ...liveEventsRef.current, [sessionId]: [] };
      setLiveEvents(liveEventsRef.current);
      await loadHermesSessions();
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function startNewTask() {
    setActivePanel("chat");
    setSelectedTaskId(undefined);
    setSelectedHermesSessionId(undefined);
    setDraft("");
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

  const managementPanel =
    activePanel === "skills" ? (
      <SkillsToolsPanel
        loading={capabilityLoading}
        query={capabilityQuery}
        saving={capabilitySaving}
        skills={skills}
        toolsets={toolsets}
        onQueryChange={setCapabilityQuery}
        onRefresh={() => void loadCapabilities()}
        onToggleSkill={(skill, enabled) => void setSkillEnabled(skill, enabled)}
        onToggleToolset={(toolset, enabled) =>
          void setToolsetEnabled(toolset, enabled)
        }
      />
    ) : activePanel === "messaging" ? (
      <MessagingPanel
        loading={capabilityLoading}
        platforms={messagingPlatforms}
        query={capabilityQuery}
        saving={capabilitySaving}
        selectedPlatformId={selectedMessagingPlatformId}
        envEdits={messagingEnvEdits}
        onQueryChange={setCapabilityQuery}
        onRefresh={() => void loadMessagingPlatforms()}
        onSelectPlatform={(platform) => {
          setSelectedMessagingPlatformId(platform.id);
          setMessagingEnvEdits({});
        }}
        onEditEnv={(key, value) =>
          setMessagingEnvEdits((current) => ({
            ...current,
            [key]: value,
          }))
        }
        onSaveEnv={(platform) => void saveMessagingPlatformEnv(platform)}
        onToggle={(platform, enabled) =>
          void setMessagingPlatformEnabled(platform, enabled)
        }
      />
    ) : null;

  return (
    <section className="agent-workspace" aria-label="Agent">
      <aside className="agent-task-rail" aria-label="Agent tasks">
        <header className="agent-rail-header">
          <div>
            <h1>Agent</h1>
            <p>
              {bridge.running
                ? `Hermes bridge running on ${bridge.connection?.port ?? "local"}`
                : "Desktop tasks with private local-tool policy."}
            </p>
          </div>
          <PanelTabs activePanel={activePanel} onChange={setActivePanel} />
          <div className="agent-rail-actions">
            {activePanel === "chat" ? (
              <button
                type="button"
                className="agent-new-task"
                onClick={() => void startNewTask()}
              >
                New session
              </button>
            ) : null}
            {!bridge.running ? (
              <button
                type="button"
                className="agent-new-task"
                disabled={bridgeStarting}
                onClick={() => void startBridge()}
              >
                {bridgeStarting ? "Starting Hermes" : "Start Hermes"}
              </button>
            ) : null}
          </div>
        </header>

        {activePanel !== "chat" ? null : (loading || hermesSessionsLoading) &&
          !hermesSessionItems.length ? (
          <div className="agent-loading">
            <Spinner size={16} />
          </div>
        ) : hermesSessionItems.length ? (
          <div className="agent-task-list">
            {hermesSessionItems.map((session) => (
              <button
                key={session.id}
                type="button"
                className="agent-task-row"
                data-active={session.id === selectedHermesSessionId}
                onClick={() => {
                  setSelectedHermesSessionId(session.id);
                  setSelectedTaskId(undefined);
                }}
              >
                <span className="agent-task-row-title">
                  {session.title || session.preview || "Untitled session"}
                </span>
                <span className="agent-task-row-meta">
                  <ActivityIndicator
                    active={workingSessionIds.has(session.id)}
                  />
                  <span>{relativeDate(sessionTimestamp(session))}</span>
                </span>
                {!workingSessionIds.has(session.id) && session.preview ? (
                  <span className="agent-task-row-summary">
                    {session.preview}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : tasks.length ? (
          <div className="agent-task-list">
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className="agent-task-row"
                data-active={task.id === selectedTask?.id}
                onClick={() => {
                  setSelectedTaskId(task.id);
                  setSelectedHermesSessionId(task.hermesSessionId);
                }}
              >
                <span className="agent-task-row-title">{task.title}</span>
                <span className="agent-task-row-meta">
                  <ActivityIndicator active={workingTaskIds.has(task.id)} />
                  <span>{relativeDate(task.updatedAt)}</span>
                </span>
                {workingTaskIds.has(task.id) ? (
                  <span className="agent-task-row-summary">Working now.</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<BotIcon size={22} />}
            title="No agent tasks"
            description="Ask the agent to do something on your desktop."
            label="No agent tasks"
          />
        )}
      </aside>

      <section className="agent-main" aria-label="Agent task details">
        {error ? <p className="error-banner">{error}</p> : null}
        {managementPanel ??
          (selectedHermesSessionId ? (
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
                <div className="agent-actions">
                  <button
                    type="button"
                    className="agent-icon-button"
                    aria-label="Refresh session"
                    onClick={() =>
                      void refreshHermesSession(selectedHermesSessionId)
                    }
                  >
                    <RotateCwIcon size={15} />
                  </button>
                </div>
              </header>
              <div ref={listRef} className="agent-timeline">
                <SafetyPanel />
                {buildHermesSessionChatTurns(
                  selectedHermesMessages,
                  liveEvents[selectedHermesSessionId] ?? [],
                ).map((turn) => (
                  <AgentChatTurnRow key={turn.id} turn={turn} />
                ))}
              </div>
            </>
          ) : selectedTask ? (
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
                  <AgentChatTurnRow key={turn.id} turn={turn} />
                ))}
              </div>
            </>
          ) : (
            <div className="agent-compose-empty">
              <EmptyState
                icon={<BotIcon size={24} />}
                title="Start an agent task"
                description="Create a task and the agent will track chat, status, and local-tool activity separately from your notes."
                label="Start an agent task"
              />
            </div>
          ))}

        {activePanel === "chat" ? (
          <form
            className="agent-composer"
            onSubmit={(event) => void submit(event)}
          >
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder={
                selectedHermesSessionId || selectedTask
                  ? "Send a follow-up"
                  : "Ask the agent to complete a desktop task"
              }
              rows={2}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button type="submit" disabled={submitting || !draft.trim()}>
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

function SkillsToolsPanel({
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

function MessagingPanel({
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

function AgentChatTurnRow({ turn }: { turn: AgentChatTurn }) {
  const textParts = turn.parts.filter(
    (part): part is Extract<AgentChatPart, { type: "text" }> =>
      part.type === "text",
  );
  const nonTextParts = turn.parts.filter((part) => part.type !== "text");

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
            <MarkdownContent
              key={`${turn.id}:text:${index}`}
              markdown={part.text}
            />
          ) : part.type === "reasoning" ? (
            <ReasoningPart key={`${turn.id}:reasoning:${index}`} part={part} />
          ) : (
            <AgentToolPartRow key={`${turn.id}:tool:${part.id}`} part={part} />
          ),
        )}
        {textParts.length === 0 && nonTextParts.length === 0 ? (
          <p className="agent-assistant-empty">Waiting for Hermes...</p>
        ) : null}
      </div>
    </article>
  );
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
