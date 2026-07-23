import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconFileText } from "central-icons/IconFileText";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { IconStop } from "central-icons/IconStop";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { agentRuntimeBindings, listVeniceModels, type VeniceModelDto } from "../../lib/tauri";
import { dispatchAgentSessionStatus, dispatchAgentSessionsChanged } from "../../lib/agent-events";
import { messageFromError } from "../../lib/errors";
import { AgentChatTurnRow } from "./chat-turns/AgentChatTurnRow";
import { AgentArtifactList, type AgentArtifact } from "./chat-turns/AgentArtifactPanel";
import { AgentSessionBar } from "./chat-turns/AgentSessionBar";
import { AgentThinking } from "./AgentThinking";
import { advanceHeroGreeting, AGENT_SHORTCUTS } from "./agent-workspace-config";
import {
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
const DEFAULT_MODEL = "auto";

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
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

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
    const list = listRef.current;
    if (list && typeof list.scrollTo === "function") {
      list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    }
  }, [projection.items]);

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
      const run = await agentRuntimeBindings.startRun({
        sessionId: activeSession.id,
        prompt,
        model: activeSession.model || model,
        safetyMode: activeSession.safetyMode,
        workspacePath: activeSession.workspacePath,
        enabledSkillIds: [],
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
      <div className="agent-scroll">
        <main className="agent-main" data-hero={heroMode ? "true" : undefined}>
          {error ? (
            <div className="agent-composer-notice" role="alert">
              {error}
            </div>
          ) : null}
          {heroMode ? (
            <>
              <div className="agent-hero-heading">
                <h2 className="agent-hero-title">{heroGreeting}</h2>
              </div>
              <AgentComposer
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
                onSubmit={submit}
                onStop={stop}
                working={running || submitting}
                disabledReason={creditActionsDisabledReason}
                hero
              />
              <div className="agent-hero-suggestions">
                <div className="agent-hero-chips">
                  {AGENT_SHORTCUTS.slice(0, 3).map((shortcut, index) => (
                    <button
                      key={shortcut.key}
                      type="button"
                      className="agent-hero-chip"
                      style={{ "--chip-i": index } as React.CSSProperties}
                      onClick={() => setDraft(shortcut.prompt)}
                    >
                      <span className="agent-hero-chip-icon" aria-hidden>
                        {shortcut.icon}
                      </span>
                      {shortcut.title}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div ref={listRef} className="agent-timeline">
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
          )}
        </main>
      </div>
      {!heroMode ? (
        <AgentComposer
          draft={draft}
          setDraft={setDraft}
          model={selectedSession?.model ?? model}
          setModel={setModel}
          models={models}
          safetyMode={selectedSession?.safetyMode ?? safetyMode}
          setSafetyMode={setSafetyMode}
          attachments={attachments}
          setAttachments={setAttachments}
          onPickAttachments={pickAttachments}
          onSubmit={submit}
          onStop={stop}
          working={running || submitting}
          disabledReason={creditActionsDisabledReason}
          locked
        />
      ) : null}
    </section>
  );
}

function AgentComposer({
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
  onSubmit,
  onStop,
  working,
  disabledReason,
  hero = false,
  locked = false,
}: {
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
  onSubmit: (event?: FormEvent) => Promise<void>;
  onStop: () => Promise<void>;
  working: boolean;
  disabledReason?: string;
  hero?: boolean;
  locked?: boolean;
}) {
  return (
    <form
      className="agent-composer"
      data-hero={hero ? "true" : undefined}
      onSubmit={(event) => void onSubmit(event)}
    >
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
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          className="agent-composer-editor"
          aria-label="Message June"
          placeholder="Ask June anything"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void onSubmit();
            }
          }}
        />
        <div className="agent-composer-toolbar">
          <button
            type="button"
            className="agent-composer-add"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => void onPickAttachments()}
          >
            <IconPlusMedium size={18} />
            <IconFileText size={14} />
          </button>
          <button
            type="button"
            className="agent-sandbox-trigger"
            disabled={locked || working}
            title={locked ? "Safety mode is fixed for this session" : "Change what June can touch"}
            onClick={() => setSafetyMode(safetyMode === "sandboxed" ? "unrestricted" : "sandboxed")}
          >
            {safetyMode === "sandboxed" ? (
              <IconShieldCheck size={14} />
            ) : (
              <IconShieldCrossed size={14} />
            )}
            {safetyMode === "sandboxed" ? "Sandboxed" : "Unrestricted"}
          </button>
          <div className="agent-composer-actions">
            <select
              className="agent-composer-model-trigger"
              aria-label="Model"
              value={model}
              disabled={locked || working}
              onChange={(event) => setModel(event.currentTarget.value)}
            >
              {!models.some((item) => item.id === model) ? (
                <option value={model}>{model}</option>
              ) : null}
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            {working ? (
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
                disabled={!draft.trim() || Boolean(disabledReason)}
                title={disabledReason}
              >
                <IconArrowUp size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
