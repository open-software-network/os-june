import {
  BotIcon,
  CheckCircle2Icon,
  CircleStopIcon,
  ClockIcon,
  MessageSquareIcon,
  PauseIcon,
  PlayIcon,
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
  type HermesSkillInfo,
  type HermesToolsetInfo,
  type HermesBridgeStatus,
} from "../../lib/tauri";
import {
  HermesGatewayClient,
  type HermesGatewayEvent,
  type HermesSessionCreateResponse,
} from "../../lib/hermes-gateway";

const POLLED_STATUSES = new Set<AgentTaskStatus>([
  "queued",
  "running",
  "waitingForUser",
]);

type LiveHermesEvent = HermesGatewayEvent & {
  receivedAt: string;
};

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
  const [liveEvents, setLiveEvents] = useState<
    Record<string, LiveHermesEvent[]>
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
  const gatewayRef = useRef<HermesGatewayClient | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const autoStartRequestedRef = useRef(false);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId),
    [selectedTaskId, tasks],
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
      setSelectedTaskId((current) => current ?? response.items[0]?.id);
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await hermesBridgeStatus();
        if (cancelled) return;
        setBridge(status);
        if (!status.running && !autoStartRequestedRef.current) {
          autoStartRequestedRef.current = true;
          await startBridge();
        }
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
  }, [selectedTask?.messages.length, selectedTask?.toolEvents.length]);

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
      const task = selectedTask
        ? await sendAgentMessage({
            taskId: selectedTask.id,
            content,
            runPlaceholder: false,
          })
        : await createAgentTask({
            prompt: content,
            safetyProfile: "autonomousPrivate",
            runPlaceholder: false,
          });
      upsertTask(task);
      void submitToHermes(task, content);
      setError(null);
    } catch (err) {
      setDraft(content);
      setError(messageFromError(err));
    } finally {
      setSubmitting(false);
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
      const existingSessionId = hermesSessions[task.id];
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
      const unlisten = gateway.onEvent((event) => {
        if (event.session_id !== sessionId) return;
        setLiveEvents((prev) => ({
          ...prev,
          [task.id]: [
            ...(prev[task.id] ?? []),
            { ...event, receivedAt: new Date().toISOString() },
          ].slice(-200),
        }));
        if (event.type === "message.complete") unlisten();
      });
      await gateway.request("prompt.submit", {
        session_id: sessionId,
        text: content,
      });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function startNewTask() {
    setActivePanel("chat");
    setSelectedTaskId(undefined);
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
      setSkills((current) =>
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
      setToolsets((current) =>
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
      setMessagingPlatforms((current) =>
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
          <div className="agent-rail-actions">
            <button
              type="button"
              className="agent-new-task"
              disabled={bridgeStarting || bridge.running}
              onClick={() => void startBridge()}
            >
              {bridgeStarting
                ? "Starting"
                : bridge.running
                  ? "Hermes on"
                  : "Retry Hermes"}
            </button>
            <button
              type="button"
              className="agent-new-task"
              onClick={() => void startNewTask()}
            >
              New task
            </button>
          </div>
        </header>

        {loading ? (
          <div className="agent-loading">
            <Spinner size={16} />
          </div>
        ) : tasks.length ? (
          <div className="agent-task-list">
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className="agent-task-row"
                data-active={task.id === selectedTask?.id}
                onClick={() => setSelectedTaskId(task.id)}
              >
                <span className="agent-task-row-title">{task.title}</span>
                <span className="agent-task-row-meta">
                  <StatusPill status={task.status} />
                  <span>{relativeDate(task.updatedAt)}</span>
                </span>
                {task.progressSummary ? (
                  <span className="agent-task-row-summary">
                    {task.progressSummary}
                  </span>
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
        {selectedTask ? (
          <>
            <header className="agent-detail-header">
              <div className="agent-detail-title">
                <StatusIcon status={selectedTask.status} />
                <div>
                  <h2>{selectedTask.title}</h2>
                  <p>{selectedTask.progressSummary ?? "Ready"}</p>
                </div>
              </div>
              <div className="agent-actions">
                <PanelTabs activePanel={activePanel} onChange={setActivePanel} />
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
            {activePanel === "chat" ? (
              <div ref={listRef} className="agent-timeline">
                <SafetyPanel />
                {mergeTimeline(
                  selectedTask.messages,
                  selectedTask.toolEvents,
                  liveEvents[selectedTask.id] ?? [],
                ).map((item) =>
                  item.kind === "message" ? (
                    <MessageBubble
                      key={item.message.id}
                      message={item.message}
                    />
                  ) : item.kind === "tool" ? (
                    <ToolEventRow key={item.event.id} event={item.event} />
                  ) : item.kind === "hermes-message" ? (
                    <HermesMessageRow key={item.item.id} item={item.item} />
                  ) : item.kind === "hermes-tool" ? (
                    <HermesToolRow key={item.item.id} item={item.item} />
                  ) : (
                    <HermesNoteRow key={item.item.id} item={item.item} />
                  ),
                )}
              </div>
            ) : activePanel === "skills" ? (
              <SkillsToolsPanel
                loading={capabilityLoading}
                query={capabilityQuery}
                saving={capabilitySaving}
                skills={skills}
                toolsets={toolsets}
                onQueryChange={setCapabilityQuery}
                onRefresh={() => void loadCapabilities()}
                onToggleSkill={(skill, enabled) =>
                  void setSkillEnabled(skill, enabled)
                }
                onToggleToolset={(toolset, enabled) =>
                  void setToolsetEnabled(toolset, enabled)
                }
              />
            ) : (
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
            )}
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
        )}

        <form
          className="agent-composer"
          data-hidden={selectedTask ? activePanel !== "chat" : false}
          onSubmit={(event) => void submit(event)}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder={
              selectedTask
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
            <span>{selectedTask ? "Send" : "Create"}</span>
          </button>
        </form>
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
                const requiredTotal = envVars.filter((field) => field.required)
                  .length;
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
                ? field.redactedValue ??
                  field.redacted_value ??
                  "Replace current value"
                : field.prompt ?? field.key
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
      <p>{message.content}</p>
    </article>
  );
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
      <p>{item.text}</p>
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
      <p>{item.text}</p>
    </details>
  );
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
  item:
    | HermesSkillInfo
    | HermesToolsetInfo
    | HermesMessagingPlatformInfo,
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

function StatusIcon({ status }: { status: AgentTaskStatus }) {
  if (status === "completed") return <CheckCircle2Icon size={18} />;
  if (status === "running" || status === "queued")
    return <PlayIcon size={18} />;
  if (status === "cancelled") return <CircleStopIcon size={18} />;
  if (status === "paused") return <PauseIcon size={18} />;
  return <ClockIcon size={18} />;
}

function toolStatusToTaskStatus(
  status: AgentToolEventDto["status"],
): AgentTaskStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "running" || status === "proposed") return "running";
  return "waitingForUser";
}

function statusLabel(status: AgentTaskStatus) {
  switch (status) {
    case "waitingForUser":
      return "Waiting";
    default:
      return status[0].toUpperCase() + status.slice(1);
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
