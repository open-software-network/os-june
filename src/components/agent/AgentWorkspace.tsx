import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconFileText } from "central-icons/IconFileText";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { IconStop } from "central-icons/IconStop";
import {
  type CSSProperties,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  agentItemsToChatTurns,
  applyAgentRuntimeEvent,
  createAgentRuntimeProjection,
  type AgentRuntimeProjection,
} from "../../lib/agent-runtime-adapter";
import type {
  AgentArtifactDto,
  AgentItemDto,
  AgentRuntimeEvent,
  AgentSafetyMode,
  AgentSessionDto,
} from "../../lib/agent-runtime-contract";
import {
  agentRuntimeBindings,
  dictationHelperCommand,
  listVeniceModels,
  type VeniceModelDto,
} from "../../lib/tauri";
import { dispatchAgentSessionStatus, dispatchAgentSessionsChanged } from "../../lib/agent-events";
import { messageFromError } from "../../lib/errors";
import { AgentChatTurnRow } from "./chat-turns/AgentChatTurnRow";
import { AgentArtifactList, type AgentArtifact } from "./chat-turns/AgentArtifactPanel";
import { AgentSessionBar } from "./chat-turns/AgentSessionBar";
import { AgentThinking } from "./AgentThinking";
import {
  advanceHeroGreeting,
  AGENT_NEW_SESSION_EVENT,
  AGENT_SHORTCUTS,
  rememberUnrestrictedAcknowledged,
  SANDBOX_OPTIONS,
  unrestrictedAcknowledged,
} from "./agent-workspace-config";
import { ComposerEditor, type ComposerEditorHandle } from "./composer/ComposerEditor";
import { agentComposerClearance } from "./composer/layout";
import {
  ComposerModelPicker,
  ComposerModelPopover,
  heroPrivacyFootnote,
  type ComposerModelFlyout,
} from "./composer/ModelPicker";
import { modelPrivacyBadge } from "../../lib/model-privacy";
import { AUTO_MODEL_ID, modelOptions, selectedModel } from "../settings/ModelPickerDialog";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";
import {
  type AgentNewSessionDetail,
  pendingNewSessionRequest,
  writeLastOpenSessionId,
  forgetLastOpenSessionId,
} from "./session-persistence";
import type { AgentWorkspaceProps } from "./agent-workspace-types";

export type { AgentWorkspaceOrigin } from "./agent-workspace-types";
export { markAgentNewSessionPending } from "./session-persistence";
export { pendingNewSessionRequest, type AgentNewSessionDetail } from "./session-persistence";
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

export const AGENT_RUNTIME_EVENT = "june://agent-runtime-event";
const DEFAULT_MODEL = AUTO_MODEL_ID;

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

function titleFromPrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 52 ? `${normalized.slice(0, 51).trimEnd()}…` : normalized;
}

function artifactView(artifact: AgentArtifactDto): AgentArtifact {
  return {
    name: artifact.name,
    path: artifact.path,
    rootLabel: "June workspace",
    size: artifact.sizeBytes,
  };
}

export function AgentWorkspace({
  initialSession,
  initialSessionId,
  origin,
  onSessionSelected,
  onMoveSessionToProject,
  sessionInProject = false,
  projectContext,
  creditActionsDisabledReason,
}: AgentWorkspaceProps = {}) {
  const initialAgentSession = initialSession;
  const pendingRequestRef = useRef(pendingNewSessionRequest());
  const [sessions, setSessions] = useState<AgentSessionDto[]>(
    initialAgentSession ? [initialAgentSession] : [],
  );
  const [selectedId, setSelectedId] = useState(initialSession?.id ?? initialSessionId);
  const [newSessionMode, setNewSessionMode] = useState(!initialSession && !initialSessionId);
  const [projection, setProjection] = useState<AgentRuntimeProjection>(() =>
    createAgentRuntimeProjection({ session: initialAgentSession }),
  );
  const [artifacts, setArtifacts] = useState<AgentArtifactDto[]>([]);
  const [models, setModels] = useState<VeniceModelDto[]>([]);
  const [model, setModel] = useState(initialAgentSession?.model || DEFAULT_MODEL);
  const [safetyMode, setSafetyMode] = useState<AgentSafetyMode>(
    initialAgentSession?.safetyMode ?? "sandboxed",
  );
  const [draft, setDraft] = useState(pendingRequestRef.current?.prompt ?? "");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [approvalSubmitting, setApprovalSubmitting] = useState<
    Partial<Record<string, "once" | "session" | "always" | "deny">>
  >({});
  const [clarifySubmitting, setClarifySubmitting] = useState<Record<string, string>>({});
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
  const [heroGreeting] = useState(advanceHeroGreeting);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const [composerClearance, setComposerClearance] = useState(0);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const startNewSession = useCallback(
    (request?: AgentNewSessionDetail) => {
      setSelectedId(undefined);
      selectedIdRef.current = undefined;
      setNewSessionMode(true);
      setProjection(createAgentRuntimeProjection());
      setArtifacts([]);
      setDraft(request?.prompt ?? "");
      setAttachments([]);
      setSubmitting(false);
      setError(undefined);
      onSessionSelected?.(undefined);
    },
    [onSessionSelected],
  );

  const selectedSession =
    sessions.find((session) => session.id === selectedId) ?? projection.session;
  const running = projection.run?.status === "running" || projection.run?.status === "queued";
  const waiting = projection.run?.status === "waiting_for_user";
  const turns = useMemo(() => agentItemsToChatTurns(projection.items), [projection.items]);

  const publishSessions = useCallback((next: AgentSessionDto[]) => {
    setSessions(next);
    dispatchAgentSessionsChanged({
      sessions: next,
      selectedSessionId: selectedIdRef.current,
      workingSessionIds: next
        .filter((session) => session.status === "running")
        .map((session) => session.id),
      waitingSessionIds: next
        .filter((session) => session.status === "waiting_for_user")
        .map((session) => session.id),
    });
  }, []);

  const refreshSessions = useCallback(async () => {
    const next = await agentRuntimeBindings.listSessions();
    publishSessions(next);
    return next;
  }, [publishSessions]);

  const hydrate = useCallback(
    async (sessionId: string) => {
      const [session, items, files] = await Promise.all([
        agentRuntimeBindings.getSession(sessionId),
        agentRuntimeBindings.listItems(sessionId),
        agentRuntimeBindings.listArtifacts(sessionId),
      ]);
      if (selectedIdRef.current !== sessionId) return;
      setProjection(createAgentRuntimeProjection({ session, items }));
      setArtifacts(files);
      setModel(session.model);
      setSafetyMode(session.safetyMode);
      setNewSessionMode(false);
      writeLastOpenSessionId(sessionId);
      onSessionSelected?.(session);
    },
    [onSessionSelected],
  );

  useEffect(() => {
    void refreshSessions().catch((cause) => setError(messageFromError(cause)));
    void listVeniceModels("generation")
      .then((response) => {
        setModels(response.models);
        if (!initialAgentSession?.model && response.selectedModel) setModel(response.selectedModel);
      })
      .catch(() => undefined);
  }, [initialAgentSession?.model, refreshSessions]);

  useEffect(() => {
    const nextId = initialSession?.id ?? initialSessionId;
    if (!nextId) return;
    setSelectedId(nextId);
    selectedIdRef.current = nextId;
    if (initialSession) {
      setSessions((current) => [
        initialSession,
        ...current.filter((session) => session.id !== initialSession.id),
      ]);
      setProjection((current) => ({ ...current, session: initialSession }));
      setModel(initialSession.model || DEFAULT_MODEL);
      setSafetyMode(initialSession.safetyMode);
      setNewSessionMode(false);
    }
    void hydrate(nextId).catch((cause) => setError(messageFromError(cause)));
  }, [hydrate, initialSession?.id, initialSessionId]);

  useEffect(() => {
    const handleNewSession = (event: Event) => {
      const pending = pendingNewSessionRequest();
      const detail = (event as CustomEvent<AgentNewSessionDetail>).detail;
      startNewSession(detail ?? pending);
    };
    window.addEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
    return () => window.removeEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
  }, [startNewSession]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AgentRuntimeEvent>(AGENT_RUNTIME_EVENT, ({ payload }) => {
      if (payload.sessionId !== selectedIdRef.current) {
        void refreshSessions().catch(() => undefined);
        return;
      }
      setProjection((current) => applyAgentRuntimeEvent(current, payload));
      dispatchAgentSessionStatus({
        sessionId: payload.sessionId,
        status:
          payload.method === "interruption.requested"
            ? "waitingForUser"
            : payload.method === "run.completed"
              ? "completed"
              : payload.method === "run.cancelled"
                ? "cancelled"
                : payload.method === "run.failed"
                  ? "failed"
                  : "running",
      });
      if (
        payload.method === "run.completed" ||
        payload.method === "run.cancelled" ||
        payload.method === "run.failed"
      ) {
        setSubmitting(false);
        void Promise.all([hydrate(payload.sessionId), refreshSessions()]);
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [hydrate, refreshSessions]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  }, [projection.items]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const composer = composerRef.current;
    if (newSessionMode || !selectedSession || !scroller || !composer) {
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
  }, [newSessionMode, selectedSession]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const prompt = draft.trim();
    if (!prompt || running || waiting || submitting || creditActionsDisabledReason) return;
    setSubmitting(true);
    setError(undefined);
    try {
      let session = selectedSession;
      if (!session || newSessionMode) {
        const createdSession = await agentRuntimeBindings.createSession({
          title: titleFromPrompt(prompt),
          model,
          safetyMode,
        });
        session = createdSession;
        setSelectedId(createdSession.id);
        selectedIdRef.current = createdSession.id;
        setNewSessionMode(false);
        setSessions((current) => [
          createdSession,
          ...current.filter((item) => item.id !== createdSession.id),
        ]);
        onSessionSelected?.(createdSession);
        writeLastOpenSessionId(createdSession.id);
      }
      const activeSession = session;
      const optimistic: AgentItemDto = {
        id: `optimistic:${crypto.randomUUID()}`,
        sessionId: activeSession.id,
        sequence: Math.max(0, ...projection.items.map((item) => item.sequence)) + 1,
        createdAt: new Date().toISOString(),
        kind: "message",
        role: "user",
        text: prompt,
        status: "complete",
        attachments: attachments.map((path, index) => ({
          id: `attachment:${index}:${path}`,
          sessionId: activeSession.id,
          name: path.split(/[\\/]/).pop() || path,
          path,
          action: "imported",
          available: true,
          createdAt: new Date().toISOString(),
        })),
      };
      setProjection((current) => ({
        ...current,
        session: activeSession,
        items: [...current.items, optimistic],
      }));
      setDraft("");
      const attachedPaths = attachments;
      setAttachments([]);
      const enabledSkillIds = (await agentRuntimeBindings.listSkills())
        .filter((skill) => skill.enabled)
        .map((skill) => skill.id);
      const run = await agentRuntimeBindings.startRun({
        sessionId: activeSession.id,
        prompt,
        model,
        safetyMode,
        workspacePath: activeSession.workspacePath,
        enabledSkillIds,
        attachments: attachedPaths,
      });
      setProjection((current) => ({ ...current, run }));
      dispatchAgentSessionStatus({
        sessionId: activeSession.id,
        title: activeSession.title,
        status: "starting",
      });
      await refreshSessions();
    } catch (cause) {
      setSubmitting(false);
      setDraft((current) => current || prompt);
      setError(messageFromError(cause));
    }
  }

  async function stop() {
    if (!projection.run) return;
    try {
      await agentRuntimeBindings.cancelRun(projection.run.id);
    } catch (cause) {
      setError(messageFromError(cause));
    }
  }

  async function respondToApproval(
    interruptionId: string,
    choice: "once" | "session" | "always" | "deny",
  ) {
    setApprovalSubmitting((current) => ({ ...current, [interruptionId]: choice }));
    try {
      const run = await agentRuntimeBindings.resolveInterruption({
        interruptionId,
        resolution: { kind: "approval", choice },
      });
      setProjection((current) => ({ ...current, run }));
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setApprovalSubmitting((current) => {
        const next = { ...current };
        delete next[interruptionId];
        return next;
      });
    }
  }

  async function respondToClarification(interruptionId: string, answer: string) {
    setClarifySubmitting((current) => ({ ...current, [interruptionId]: answer }));
    try {
      const run = await agentRuntimeBindings.resolveInterruption({
        interruptionId,
        resolution: { kind: "clarification", answer },
      });
      setProjection((current) => ({ ...current, run }));
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setClarifySubmitting((current) => {
        const next = { ...current };
        delete next[interruptionId];
        return next;
      });
    }
  }

  async function pickAttachments() {
    const selected = await openFileDialog({ multiple: true, title: "Attach files" });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setAttachments((current) => [...new Set([...current, ...paths])].slice(0, 8));
  }

  async function startDictation() {
    if (creditActionsDisabledReason) {
      setError(creditActionsDisabledReason);
      return;
    }
    try {
      await dictationHelperCommand({ type: "toggle_listening", shortcut: "Dictation" });
    } catch (cause) {
      setError(messageFromError(cause));
    }
  }

  async function rename(title: string) {
    if (!selectedId) return;
    const updated = await agentRuntimeBindings.renameSession(selectedId, title);
    setSessions((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setProjection((current) => ({ ...current, session: updated }));
    onSessionSelected?.(updated);
  }

  async function remove() {
    if (!selectedId) return;
    await agentRuntimeBindings.deleteSession(selectedId);
    forgetLastOpenSessionId(selectedId);
    setSelectedId(undefined);
    setProjection(createAgentRuntimeProjection());
    setArtifacts([]);
    setNewSessionMode(true);
    onSessionSelected?.(undefined);
    await refreshSessions();
  }

  const heroMode = newSessionMode && !selectedSession;
  const renderedArtifacts = artifacts.filter((artifact) => artifact.available).map(artifactView);
  const activeModel = selectedModel(models, model);
  const composer = (
    <AgentComposer
      formRef={composerRef}
      scrollRef={scrollRef}
      draft={draft}
      setDraft={setDraft}
      model={model}
      setModel={setModel}
      models={models}
      safetyMode={safetyMode}
      setSafetyMode={setSafetyMode}
      attachments={attachments}
      setAttachments={setAttachments}
      onPickAttachments={pickAttachments}
      onDictate={startDictation}
      onSubmit={submit}
      onStop={stop}
      running={running}
      submitting={submitting}
      disabledReason={creditActionsDisabledReason}
      hero={heroMode}
    />
  );
  return (
    <section
      className="agent-workspace"
      aria-label="Session"
      data-hero={heroMode ? "true" : undefined}
    >
      {!heroMode ? (
        <AgentSessionBar
          origin={origin}
          title={selectedSession?.title ?? ""}
          fullMode={selectedSession?.safetyMode === "unrestricted"}
          artifactCount={renderedArtifacts.length}
          inProject={sessionInProject}
          projectContext={projectContext}
          onRename={rename}
          onMoveToProject={
            selectedId && onMoveSessionToProject
              ? () => onMoveSessionToProject(selectedId)
              : undefined
          }
          onDelete={remove}
        />
      ) : null}
      {heroMode ? (
        <main className="agent-main" aria-label="Agent task details" data-hero="true">
          {error ? (
            <div className="agent-composer-notice" role="alert">
              {error}
            </div>
          ) : null}
          <div className="agent-hero-heading">
            <h2 className="agent-hero-title">{heroGreeting}</h2>
          </div>
          {composer}
          <div className="agent-hero-suggestions">
            <div className="agent-hero-chips" data-hidden={draft.trim() ? "true" : undefined}>
              {AGENT_SHORTCUTS.slice(0, 3).map((shortcut, index) => (
                <button
                  key={shortcut.key}
                  type="button"
                  className="agent-hero-chip"
                  style={{ "--chip-i": index } as CSSProperties}
                  title={shortcut.description}
                  disabled={submitting}
                  onClick={() => setDraft(shortcut.prompt)}
                >
                  <span className="agent-hero-chip-icon" aria-hidden>
                    {shortcut.icon}
                  </span>
                  {shortcut.title}
                </button>
              ))}
            </div>
            <p className="agent-hero-footnote">
              {heroPrivacyFootnote(
                activeModel,
                activeModel ? modelPrivacyBadge(activeModel) : undefined,
              )}
            </p>
          </div>
        </main>
      ) : (
        <div
          ref={scrollRef}
          className="agent-scroll"
          style={{ "--agent-composer-clearance": `${composerClearance}px` } as CSSProperties}
        >
          <main className="agent-main" aria-label="Agent task details">
            {error ? (
              <div className="agent-composer-notice" role="alert">
                {error}
              </div>
            ) : null}
            <div className="agent-timeline">
              {turns.map((turn) => (
                <AgentChatTurnRow
                  key={turn.id}
                  turn={turn}
                  approvalSubmitting={approvalSubmitting}
                  clarifySubmitting={clarifySubmitting}
                  sudoSubmitting={{}}
                  secretSubmitting={{}}
                  thinkingOpen={(key) => thinkingOpen[key] ?? false}
                  onThinkingOpenChange={(key, open) =>
                    setThinkingOpen((current) => ({ ...current, [key]: open }))
                  }
                  onApproval={(part, choice) => void respondToApproval(part.id, choice)}
                  onClarify={(part, answer) => void respondToClarification(part.id, answer)}
                  onSudo={() => undefined}
                  onSecret={() => undefined}
                />
              ))}
              <AgentArtifactList artifacts={renderedArtifacts} />
              <AgentThinking visible={running && turns.at(-1)?.role === "user"} />
            </div>
            {composer}
          </main>
        </div>
      )}
    </section>
  );
}

function AgentComposer({
  formRef,
  scrollRef,
  draft,
  setDraft,
  model,
  setModel,
  models,
  safetyMode,
  setSafetyMode,
  attachments,
  setAttachments,
  onPickAttachments,
  onDictate,
  onSubmit,
  onStop,
  running,
  submitting,
  disabledReason,
  hero = false,
}: {
  formRef: RefObject<HTMLFormElement>;
  scrollRef: RefObject<HTMLDivElement>;
  draft: string;
  setDraft: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  models: VeniceModelDto[];
  safetyMode: AgentSafetyMode;
  setSafetyMode: (value: AgentSafetyMode) => void;
  attachments: string[];
  setAttachments: (value: string[]) => void;
  onPickAttachments: () => Promise<void>;
  onDictate: () => Promise<void>;
  onSubmit: (event?: FormEvent) => Promise<void>;
  onStop: () => Promise<void>;
  running: boolean;
  submitting: boolean;
  disabledReason?: string;
  hero?: boolean;
}) {
  const editorRef = useRef<ComposerEditorHandle>(null);
  const publishedDraftRef = useRef(draft);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelFlyout, setModelFlyout] = useState<ComposerModelFlyout>(null);
  const [modelSearch, setModelSearch] = useState("");
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [confirmUnrestricted, setConfirmUnrestricted] = useState(false);
  const attachTriggerRef = useRef<HTMLButtonElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const safetyTriggerRef = useRef<HTMLButtonElement>(null);
  const safetyMenuRef = useRef<HTMLDivElement>(null);
  const activeModel = selectedModel(models, model);
  const working = running || submitting;

  useEffect(() => {
    if (draft === publishedDraftRef.current) return;
    publishedDraftRef.current = draft;
    editorRef.current?.setContent(draft, null, { focus: false });
  }, [draft]);

  useEffect(() => {
    if (!modelOpen && !safetyOpen && !attachOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modelPopoverRef.current?.contains(target) || modelTriggerRef.current?.contains(target)) {
        return;
      }
      if (safetyTriggerRef.current?.contains(target)) return;
      if (safetyMenuRef.current?.contains(target)) return;
      if (attachTriggerRef.current?.contains(target) || attachMenuRef.current?.contains(target)) {
        return;
      }
      if (target instanceof Element && target.closest(".agent-composer-model-hovercard")) return;
      setModelOpen(false);
      setSafetyOpen(false);
      setAttachOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [attachOpen, modelOpen, safetyOpen]);

  function referenceNote() {
    const prefix = draft && !/\s$/.test(draft) ? " @" : "@";
    const next = `${draft}${prefix}`;
    publishedDraftRef.current = next;
    setDraft(next);
    editorRef.current?.setContent(next, null, { focus: true });
  }

  return (
    <form
      ref={formRef}
      className="agent-composer"
      data-hero={hero ? "true" : undefined}
      onSubmit={(event) => void onSubmit(event)}
    >
      {hero ? null : (
        <AgentScrollToLatestButton
          scrollRef={scrollRef}
          onJump={() =>
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
          }
        />
      )}
      <div className="agent-composer-box">
        {attachments.length ? (
          <div className="agent-composer-attachments">
            {attachments.map((path) => (
              <span key={path} className="agent-attachment-tile">
                <IconFileText size={16} />
                <span>{path.split(/[\\/]/).pop() || path}</span>
                <button
                  type="button"
                  aria-label={`Remove ${path.split(/[\\/]/).pop() || path}`}
                  onClick={() => setAttachments(attachments.filter((item) => item !== path))}
                >
                  <IconCrossSmall size={12} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <ComposerEditor
          ref={editorRef}
          placeholder={hero ? "Ask June anything, run / commands" : "Send a message"}
          onChange={(text) => {
            publishedDraftRef.current = text;
            setDraft(text);
          }}
          onSubmit={() => void onSubmit()}
        />
        <div className="agent-composer-toolbar">
          <button
            type="button"
            ref={attachTriggerRef}
            className="agent-composer-attach"
            aria-label="Add files or notes"
            title="Add"
            aria-haspopup="menu"
            aria-expanded={attachOpen}
            data-open={attachOpen || undefined}
            onClick={() => setAttachOpen((open) => !open)}
          >
            <IconPlusMedium size={18} />
          </button>
          {hero ? (
            <button
              ref={safetyTriggerRef}
              type="button"
              className="agent-sandbox-trigger"
              data-unrestricted={safetyMode === "unrestricted" ? "true" : undefined}
              aria-haspopup="menu"
              aria-expanded={safetyOpen}
              title="Change what June can touch"
              onClick={() => setSafetyOpen((open) => !open)}
            >
              {safetyMode === "sandboxed" ? (
                <IconShieldCheck size={14} />
              ) : (
                <IconShieldCrossed size={14} />
              )}
              {safetyMode === "sandboxed" ? "Sandboxed" : "Unrestricted"}
              <IconChevronDownSmall size={12} aria-hidden />
            </button>
          ) : null}
          <div className="agent-composer-actions">
            <ComposerModelPicker
              open={modelOpen}
              model={activeModel}
              readOnly={working}
              triggerRef={modelTriggerRef}
              onToggleOpen={() => setModelOpen((open) => !open)}
            />
            <button
              type="button"
              className="agent-composer-mic"
              aria-label="Dictate"
              title={disabledReason ?? "Start dictation"}
              disabled={Boolean(disabledReason)}
              onClick={() => {
                editorRef.current?.focus();
                void onDictate();
              }}
            >
              <IconMicrophone size={18} />
            </button>
            {running ? (
              <button
                type="button"
                className="agent-composer-stop"
                aria-label="Stop June"
                onClick={() => void onStop()}
              >
                <IconStop size={16} />
              </button>
            ) : (
              <button
                type="submit"
                className="agent-composer-send"
                aria-label="Send message"
                disabled={submitting || !draft.trim() || Boolean(disabledReason)}
                title={disabledReason}
              >
                {submitting ? <Spinner /> : <IconArrowUp size={18} />}
              </button>
            )}
          </div>
        </div>
      </div>
      {attachOpen ? (
        <div
          ref={attachMenuRef}
          className="agent-attach-menu"
          role="menu"
          aria-label="Add files or notes"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAttachOpen(false);
              void onPickAttachments();
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
              setAttachOpen(false);
              referenceNote();
            }}
          >
            <span className="agent-attach-menu-icon">
              <IconNoteText size={16} aria-hidden />
            </span>
            <span className="agent-attach-menu-label">Reference a note</span>
          </button>
        </div>
      ) : null}
      {hero && safetyOpen ? (
        <div
          ref={safetyMenuRef}
          className="agent-sandbox-menu"
          role="menu"
          aria-label="Safety mode"
        >
          <p className="agent-sandbox-menu-title">Choose what June can touch</p>
          {SANDBOX_OPTIONS.map((option) => {
            const value: AgentSafetyMode = option.unrestricted ? "unrestricted" : "sandboxed";
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={safetyMode === value}
                onClick={() => {
                  setSafetyOpen(false);
                  if (value === "unrestricted" && !unrestrictedAcknowledged()) {
                    setConfirmUnrestricted(true);
                    return;
                  }
                  setSafetyMode(value);
                }}
              >
                {option.icon}
                <span className="agent-sandbox-option">
                  <span className="agent-sandbox-option-title">{option.title}</span>
                  <span className="agent-sandbox-option-desc">{option.description}</span>
                </span>
                {safetyMode === value ? (
                  <IconCheckmark2Small
                    size={14}
                    aria-hidden
                    className="agent-sandbox-option-check"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {modelOpen ? (
        <ComposerModelPopover
          flyout={modelFlyout}
          model={activeModel}
          options={modelOptions(models, model)}
          search={modelSearch}
          popoverRef={modelPopoverRef}
          searchRef={modelSearchRef}
          onFlyoutChange={setModelFlyout}
          onSearchChange={setModelSearch}
          onSelect={(nextModel) => {
            setModel(nextModel);
            setModelOpen(false);
          }}
        />
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
                setSafetyMode("unrestricted");
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
  );
}

function AgentScrollToLatestButton({
  scrollRef,
  onJump,
}: {
  scrollRef: RefObject<HTMLDivElement>;
  onJump: () => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const recheck = () => {
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      setVisible(scroller.scrollHeight > scroller.clientHeight && distanceFromBottom > 48);
    };
    recheck();
    scroller.addEventListener("scroll", recheck, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(recheck) : undefined;
    observer?.observe(scroller);
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
