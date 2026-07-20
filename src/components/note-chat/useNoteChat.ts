import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildHermesSessionChatTurns, type AgentChatTurn } from "../../lib/agent-chat-runtime";
import {
  getActiveHermesProfileName,
  refreshActiveHermesProfile,
} from "../../lib/active-hermes-profile";
import { messageFromError } from "../../lib/errors";
import { listHermesSessions } from "../../lib/hermes-adapter";
import { hermesConnectionForMode } from "../../lib/hermes-connection";
import { classifyHermesEvent } from "../../lib/hermes-control-plane/event-classifier";
import { createHermesMethods } from "../../lib/hermes-control-plane/methods";
import { isTerminalHermesEvent, type JuneHermesEvent } from "../../lib/hermes-control-plane/events";
import { isHermesFeatureSupported } from "../../lib/hermes-control-plane/compatibility/support";
import { HermesGatewayClient, isSessionBusyError } from "../../lib/hermes-gateway";
import { applySessionModelWhenIdle } from "../../lib/hermes-next-prompt-model";
import {
  canAttributeUntaggedAgentRun,
  cancelAgentRunMonitoring,
  markAgentRunSucceeded,
  startAgentRunMonitoring,
} from "../../lib/agent-run-monitor";
import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import {
  reserveHermesSessionDispatch,
  type HermesSessionDispatchReservation,
} from "../../lib/hermes-session-dispatch-mutex";
import {
  AUTO_MODEL_ID,
  decodeHermesModelSelection,
  hasPendingSessionModelSelection,
  hermesModelIdForSelection,
  markSessionModelSelectionApplied,
  readSessionModelSelections,
  rememberAppliedSessionModelSelection,
  stageSessionModelSelection,
  subscribeSessionModelSelections,
  type SessionModelSelection,
} from "../../lib/hermes-session-model-selection";
import { localGenerationOptionId } from "../../lib/local-generation";
import {
  attachImageToSession,
  pendingImageAttachments,
  type HermesAttachmentState,
} from "../../lib/hermes-image-attach";
import {
  assignSessionToProfile,
  hermesBridgeImageDataUrl,
  hermesBridgeSessionMessages,
  hermesBridgeStatus,
  providerModelSettings,
  startHermesBridge,
  type HermesSessionMessage,
  type ImportedHermesFile,
} from "../../lib/tauri";
import { noteReferenceToken, type NoteReferenceInput } from "../agent/composer/noteReference";
import { noteChatSessionIdFor, rememberNoteChatSession } from "./noteChatSessions";

type HermesRuntimeSessionResponse = {
  session_id?: string;
  stored_session_id?: string;
};

/** A file imported into the June workspace for this chat, plus its structured
 * attach state — the panel-side shape of the workspace's AgentAttachment. */
export type NoteChatAttachment = ImportedHermesFile & {
  id: string;
  attach: HermesAttachmentState;
};

/** The same path block the workspace appends, so the agent gets real,
 * readable workspace paths and the transcript strippers recognize it. */
function withAttachmentPaths(message: string, attachments: NoteChatAttachment[]): string {
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

function attachmentPromptPath(path: string) {
  const workspaceMatch = path.match(/(?:^|[/\\])workspace[/\\](.+)$/);
  if (workspaceMatch?.[1]) return workspaceMatch[1];
  return path;
}

/** Live classified events kept per open panel; matches the workspace's cap so
 * a long tool-heavy turn can't grow the array unbounded. */
const LIVE_EVENT_CAP = 200;

/* One gateway client for every note chat, module-scoped so panels across
 * note switches share the socket instead of re-handshaking. Note chats are
 * always sandboxed — the panel is a reading/asking surface; escalation to
 * the full agent view is where mode choices live. The client is a SEPARATE
 * connection from AgentWorkspace's on purpose: the gateway serves multiple
 * sockets, and sharing the workspace's client would couple the panel to the
 * monolith's ref-managed lifecycle. */
let sharedGateway: HermesGatewayClient | null = null;
let sharedGatewayConnecting: Promise<HermesGatewayClient> | null = null;
const eventSubscribers = new Set<(event: JuneHermesEvent) => void>();

function terminalAgentStatus(
  event: JuneHermesEvent,
): "completed" | "failed" | "cancelled" | undefined {
  if (!isTerminalHermesEvent(event)) return undefined;
  if (event.kind === "error") return "failed";
  if (event.kind === "transcript") return event.failed ? "failed" : "completed";
  if (event.kind !== "lifecycle") return undefined;
  if (/(?:cancel|stop|interrupt|abort)/i.test(event.status)) return "cancelled";
  if (/(?:fail|error|timeout)/i.test(event.status)) return "failed";
  return "completed";
}

async function connectGateway(startIfNeeded: boolean): Promise<HermesGatewayClient | null> {
  if (sharedGatewayConnecting) return sharedGatewayConnecting;
  const attempt = (async () => {
    let status = await hermesBridgeStatus();
    let connection = hermesConnectionForMode(status.running ? status : undefined, false);
    if (!connection) {
      if (!startIfNeeded) return null;
      status = await startHermesBridge(undefined, false);
      connection = hermesConnectionForMode(status, false);
    }
    await refreshActiveHermesProfile({ status, mode: "sandboxed" });
    const wsUrl = connection?.wsUrl;
    if (!wsUrl) throw new Error("Hermes bridge did not return a gateway URL.");
    if (!sharedGateway) {
      const gateway = new HermesGatewayClient();
      gateway.onEvent((raw) => {
        const event = classifyHermesEvent(raw);
        for (const subscriber of [...eventSubscribers]) subscriber(event);
      });
      // Unexpected drop: forget the client so the next submit reconnects
      // fresh. Subscribers persist — they are keyed to the module set, not
      // the socket.
      gateway.onClose(() => {
        if (sharedGateway === gateway) sharedGateway = null;
      });
      sharedGateway = gateway;
    }
    await sharedGateway.connect(wsUrl);
    return sharedGateway;
  })().finally(() => {
    sharedGatewayConnecting = null;
  });
  // Only coalesce concurrent callers onto attempts that resolve to a live
  // gateway; a "bridge not running" null must not stick for a later caller
  // that wants to start it.
  if (startIfNeeded) {
    sharedGatewayConnecting = attempt.then((gateway) => {
      if (!gateway) throw new Error("Hermes gateway is not connected.");
      return gateway;
    });
    return sharedGatewayConnecting;
  }
  return attempt;
}

function subscribeToGatewayEvents(subscriber: (event: JuneHermesEvent) => void) {
  eventSubscribers.add(subscriber);
  return () => {
    eventSubscribers.delete(subscriber);
  };
}

function sessionMessagesFrom(response: {
  messages?: HermesSessionMessage[];
  items?: HermesSessionMessage[];
  data?: HermesSessionMessage[];
}): HermesSessionMessage[] {
  return response.messages ?? response.items ?? response.data ?? [];
}

function sameSessionModelSelection(
  left: SessionModelSelection,
  right: SessionModelSelection,
): boolean {
  return left.modelId === right.modelId && left.costQuality === right.costQuality;
}

function selectionFromStoredHermesModel(
  hermesModelId: string,
  settings: Awaited<ReturnType<typeof providerModelSettings>>["settings"] | undefined,
): SessionModelSelection {
  const configuredLocalModelId = settings?.localGeneration.modelId.trim();
  if (
    !hermesModelId.startsWith("__june_") &&
    configuredLocalModelId &&
    hermesModelId === configuredLocalModelId
  ) {
    return { modelId: localGenerationOptionId(configuredLocalModelId) };
  }
  const selection = decodeHermesModelSelection(hermesModelId);
  return selection.modelId === AUTO_MODEL_ID &&
    selection.costQuality === undefined &&
    settings?.costQuality !== undefined
    ? { ...selection, costQuality: settings.costQuality }
    : selection;
}

function defaultSessionModelSelection(
  settings: Awaited<ReturnType<typeof providerModelSettings>>["settings"],
): SessionModelSelection {
  const localModelId = settings.localGeneration.modelId.trim();
  const modelId =
    settings.generationProvider === "local" && localModelId
      ? localGenerationOptionId(localModelId)
      : settings.generationModel;
  return {
    modelId,
    ...(modelId === AUTO_MODEL_ID && settings.costQuality !== undefined
      ? { costQuality: settings.costQuality }
      : {}),
  };
}

async function reconcileStoredSessionModelMetadata(storedSessionId: string): Promise<
  | {
      appliedHermesModelId: string;
      selection: SessionModelSelection;
    }
  | undefined
> {
  const [sessions, settingsResponse] = await Promise.all([
    listHermesSessions({ archived: "include", minMessages: 0 }).catch(() => []),
    providerModelSettings().catch(() => undefined),
  ]);
  const appliedHermesModelId =
    sessions.find((session) => session.id === storedSessionId)?.model?.trim() || undefined;
  if (!appliedHermesModelId) return undefined;

  const selection = selectionFromStoredHermesModel(
    appliedHermesModelId,
    settingsResponse?.settings,
  );
  let store = rememberAppliedSessionModelSelection(storedSessionId, selection);
  // Raw ids from older June builds do not carry provider provenance. Retain
  // the metadata model as the live baseline, but force one session-scoped
  // config.set before the next prompt to upgrade Hermes to the tagged alias.
  if (
    hermesModelIdForSelection(selection) !== appliedHermesModelId &&
    !hasPendingSessionModelSelection(store[storedSessionId])
  ) {
    store = stageSessionModelSelection(storedSessionId, store[storedSessionId].selection);
  }
  return { appliedHermesModelId, selection };
}

export type NoteChat = {
  /** The rendered conversation: persisted turns + the live streaming tail. */
  turns: AgentChatTurn[];
  /** True from an accepted submit until the turn's terminal event. */
  working: boolean;
  /** A Send is still resolving creation/resume/dispatch, even if Stop hid the busy state. */
  submissionPending: boolean;
  /** True while the persisted transcript for an existing session loads. */
  loading: boolean;
  error: string | null;
  /** The stored Hermes session id backing this note's chat, once one exists.
   * This is the id the agent view resolves the conversation by. */
  storedSessionId: string | undefined;
  /** Sends a question about the note, with any imported attachments (images
   * ride the structured attach flow before the prompt; every file's workspace
   * path rides in the prompt block). Resolves true when the prompt was
   * accepted (the caller can clear its composer), false on failure (the
   * caller keeps the draft and chips so the user can retry). */
  submit: (text: string, attachments?: NoteChatAttachment[]) => Promise<boolean>;
  /** Interrupts the running agent run. The UI reads stopped immediately; the
   * interrupt RPC follows best-effort, like the workspace's stop. */
  stop: () => void;
  /** Chooses the model for this chat: applied at session.create for a fresh
   * chat, or as a session-scoped switch ahead of the next message on a live
   * one. A change made while working remains queued for the following run. */
  modelSelection: SessionModelSelection | undefined;
  /** The model Hermes last acknowledged for this session. Legacy chats load
   * this from Hermes session metadata until they have a durable selection
   * entry of their own. */
  appliedHermesModelId: string | undefined;
  setSessionModel: (selection: SessionModelSelection) => void;
};

/** A note-scoped chat with June, powered by the same Hermes runtime as the
 * agent view but owned by the panel: its own gateway socket, its own live
 * event tail, one session per note (see noteChatSessions). The first message
 * of a session carries the note reference token, so Hermes resolves the note
 * through June's note context tool exactly like a composer note chip. */
export function useNoteChat(note: NoteReferenceInput | null): NoteChat {
  const noteId = note?.id;
  const noteTitle = note?.title ?? "";
  const [storedSessionId, setStoredSessionId] = useState<string>();
  const [messages, setMessages] = useState<HermesSessionMessage[]>([]);
  const [liveEvents, setLiveEvents] = useState<JuneHermesEvent[]>([]);
  const [pendingUserTurns, setPendingUserTurns] = useState<AgentChatTurn[]>([]);
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const [submissionPending, setSubmissionPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<SessionModelSelection | undefined>(() => {
    const noteStoredSessionId = noteId ? noteChatSessionIdFor(noteId) : undefined;
    return noteStoredSessionId
      ? readSessionModelSelections()[noteStoredSessionId]?.selection
      : undefined;
  });
  const [appliedHermesModelId, setAppliedHermesModelId] = useState<string | undefined>(() => {
    const noteStoredSessionId = noteId ? noteChatSessionIdFor(noteId) : undefined;
    const appliedSelection = noteStoredSessionId
      ? readSessionModelSelections()[noteStoredSessionId]?.appliedSelection
      : undefined;
    return appliedSelection ? hermesModelIdForSelection(appliedSelection) : undefined;
  });

  const storedSessionIdRef = useRef<string>();
  const runtimeSessionIdRef = useRef<string>();
  // The model the user picked in the panel vs the one the live session runs.
  // They converge at session.create (fresh chat) or via a session-scoped
  // config update right before the next prompt (existing chat) — never
  // during an agent run.
  const pendingModelSelectionRef = useRef<SessionModelSelection>();
  const appliedHermesModelIdRef = useRef<string>();
  const storedSessionMetadataHydratedRef = useRef(false);
  const noteGenerationRef = useRef(0);
  // Synchronous in-flight guard: React batches setWorking(true), so a rapid
  // double send (double-click, or Enter racing the send button) could both
  // pass the state-based check and each create a session / append a turn.
  const activeSubmissionRef = useRef<symbol>();
  const stoppedRuntimeSessionIdRef = useRef<string>();
  const stoppedRunRef = useRef(false);
  const liveEventsRef = useRef<JuneHermesEvent[]>([]);
  const pendingUserTurnsRef = useRef<AgentChatTurn[]>([]);
  liveEventsRef.current = liveEvents;
  pendingUserTurnsRef.current = pendingUserTurns;

  // Rebind to the note's session whenever the panel switches notes.
  useEffect(() => {
    const noteGeneration = ++noteGenerationRef.current;
    const noteStoredSessionId = noteId ? noteChatSessionIdFor(noteId) : undefined;
    storedSessionIdRef.current = noteStoredSessionId;
    runtimeSessionIdRef.current = undefined;
    const rememberedEntry = noteStoredSessionId
      ? readSessionModelSelections()[noteStoredSessionId]
      : undefined;
    const rememberedSelection = rememberedEntry?.selection;
    const rememberedAppliedHermesModelId = rememberedEntry?.appliedSelection
      ? hermesModelIdForSelection(rememberedEntry.appliedSelection)
      : undefined;
    pendingModelSelectionRef.current = rememberedSelection;
    // A crash can leave appliedSelection newer than Hermes' persisted session
    // metadata. Until that metadata loads, keep the dispatch baseline unknown
    // so an early Send performs one safe repairing config.set.
    appliedHermesModelIdRef.current = undefined;
    storedSessionMetadataHydratedRef.current = !noteStoredSessionId;
    activeSubmissionRef.current = undefined;
    setSubmissionPending(false);
    setStoredSessionId(noteStoredSessionId);
    setMessages([]);
    setLiveEvents([]);
    setPendingUserTurns([]);
    workingRef.current = false;
    setWorking(false);
    setError(null);
    setModelSelection(rememberedSelection);
    setAppliedHermesModelId(rememberedAppliedHermesModelId);
    if (!noteStoredSessionId) {
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    (async () => {
      // History lives behind the bridge; when it isn't running, skip the load
      // instead of spawning a runtime just to render an empty panel — the
      // first submit starts it and the post-turn refresh backfills history.
      const status = await hermesBridgeStatus();
      if (stale) return;
      if (!status.running) {
        setLoading(false);
        return;
      }
      const [response, metadata] = await Promise.all([
        hermesBridgeSessionMessages(noteStoredSessionId).catch(() => undefined),
        reconcileStoredSessionModelMetadata(noteStoredSessionId),
      ]);
      if (stale || noteGenerationRef.current !== noteGeneration) return;
      if (response) setMessages(sessionMessagesFrom(response));
      const currentEntry = readSessionModelSelections()[noteStoredSessionId];
      // Hermes session metadata is the conservative live baseline even when
      // an entry exists: config.set can succeed just before June crashes while
      // persisting its acknowledgement. Reapplying the desired model once is
      // safe; trusting a stale appliedSelection as newer than Hermes is not.
      const currentAppliedHermesModelId =
        metadata?.appliedHermesModelId ??
        (currentEntry?.appliedSelection
          ? hermesModelIdForSelection(currentEntry.appliedSelection)
          : undefined);
      storedSessionMetadataHydratedRef.current = true;
      appliedHermesModelIdRef.current = currentAppliedHermesModelId;
      setAppliedHermesModelId(currentAppliedHermesModelId);
      setLoading(false);
    })().catch(() => {
      // A missing/unreadable transcript degrades to an empty panel; the
      // pairing is kept so a submit still continues the same session.
      if (!stale) setLoading(false);
    });
    return () => {
      stale = true;
    };
  }, [noteId]);

  useEffect(
    () =>
      subscribeSessionModelSelections((store) => {
        const currentStoredSessionId = storedSessionIdRef.current;
        if (!currentStoredSessionId) return;
        const nextEntry = store[currentStoredSessionId];
        const nextSelection = nextEntry?.selection;
        pendingModelSelectionRef.current = nextSelection;
        setModelSelection(nextSelection);
        if (nextEntry && storedSessionMetadataHydratedRef.current) {
          const nextAppliedHermesModelId = nextEntry.appliedSelection
            ? hermesModelIdForSelection(nextEntry.appliedSelection)
            : undefined;
          appliedHermesModelIdRef.current = nextAppliedHermesModelId;
          setAppliedHermesModelId(nextAppliedHermesModelId);
        }
      }),
    [],
  );

  const refreshTranscript = useCallback(async () => {
    const currentStoredSessionId = storedSessionIdRef.current;
    if (!currentStoredSessionId) return;
    // Snapshot how much live state this refresh supersedes: events that land
    // while the fetch is in flight belong to a newer beat and must survive it.
    const supersededEvents = liveEventsRef.current.length;
    const supersededPending = pendingUserTurnsRef.current.length;
    try {
      const response = await hermesBridgeSessionMessages(currentStoredSessionId);
      setMessages(sessionMessagesFrom(response));
      setLiveEvents((current) => current.slice(supersededEvents));
      setPendingUserTurns((current) => current.slice(supersededPending));
    } catch {
      // Keep rendering from the live tail; the next terminal event retries.
    }
  }, []);

  // The live tail: classified gateway events for THIS note's session only.
  useEffect(() => {
    return subscribeToGatewayEvents((event) => {
      const eventRuntimeOrStoredSessionId = "sessionId" in event ? event.sessionId : undefined;
      const matchesSession =
        eventRuntimeOrStoredSessionId === runtimeSessionIdRef.current ||
        eventRuntimeOrStoredSessionId === storedSessionIdRef.current;
      const terminal = isTerminalHermesEvent(event);
      // A tagged event for a different session isn't ours. A terminal frame
      // can arrive WITHOUT a session id (error / lifecycle), though — and this
      // gateway only ever serves the one active note chat, so an untagged
      // terminal event can only mean our in-flight turn ended: clear `working`
      // so the toolbar dot can't stick busy. Untagged non-terminal events stay
      // dropped (they can't be attributed to our transcript).
      if (eventRuntimeOrStoredSessionId && !matchesSession) return;
      if (!eventRuntimeOrStoredSessionId && !terminal) return;
      if (
        !eventRuntimeOrStoredSessionId &&
        terminal &&
        (!workingRef.current ||
          !storedSessionIdRef.current ||
          !canAttributeUntaggedAgentRun(storedSessionIdRef.current, false))
      ) {
        return;
      }
      if (matchesSession) {
        setLiveEvents((current) => [...current, event].slice(-LIVE_EVENT_CAP));
      }
      if (terminal) {
        workingRef.current = false;
        setWorking(false);
        const currentStoredSessionId = storedSessionIdRef.current;
        const stoppedByUser =
          stoppedRunRef.current &&
          (!eventRuntimeOrStoredSessionId ||
            eventRuntimeOrStoredSessionId === stoppedRuntimeSessionIdRef.current);
        if (event.kind === "error") {
          setError(event.message);
        } else if (matchesSession) {
          void refreshTranscript();
        }
        if (!currentStoredSessionId || stoppedByUser) return;
        const terminalStatus = terminalAgentStatus(event);
        if (terminalStatus === "completed") {
          markAgentRunSucceeded(currentStoredSessionId);
        } else if (terminalStatus) {
          cancelAgentRunMonitoring(currentStoredSessionId);
          dispatchAgentSessionStatus({
            sessionId: currentStoredSessionId,
            title: noteTitle.trim() || "Note chat",
            status: terminalStatus,
            summary:
              terminalStatus === "cancelled"
                ? "Stopped."
                : event.kind === "error"
                  ? event.message
                  : "June stopped before replying.",
          });
        }
      }
    });
  }, [noteTitle, refreshTranscript]);

  const submit = useCallback(
    async (rawText: string, attachments: NoteChatAttachment[] = []): Promise<boolean> => {
      const question = rawText.trim();
      if ((!question && !attachments.length) || !noteId) return false;
      // Reject a second send that races the first before setWorking(true)
      // commits — otherwise both could create a session and submit the prompt.
      if (activeSubmissionRef.current) return false;
      const submissionToken = Symbol("note-chat-submit");
      activeSubmissionRef.current = submissionToken;
      setSubmissionPending(true);
      const noteGeneration = noteGenerationRef.current;
      const submissionIsCurrent = () =>
        noteGenerationRef.current === noteGeneration &&
        activeSubmissionRef.current === submissionToken;
      setError(null);
      const startingStoredSessionId = storedSessionIdRef.current;
      const startingRuntimeSessionId = runtimeSessionIdRef.current;
      const isFirstMessage = !startingStoredSessionId;
      // Capture before the first await. A picker change after this point is for
      // the following run, even if session creation/resume is still pending.
      let capturedModelSelection = pendingModelSelectionRef.current;
      const defaultModelSelectionSnapshot =
        !capturedModelSelection && !startingStoredSessionId
          ? providerModelSettings().then(({ settings }) => defaultSessionModelSelection(settings))
          : undefined;
      const capturedModelEntry = startingStoredSessionId
        ? readSessionModelSelections()[startingStoredSessionId]
        : undefined;
      let capturedHermesModelId = capturedModelSelection
        ? hermesModelIdForSelection(capturedModelSelection)
        : undefined;
      let capturedAppliedHermesModelId = appliedHermesModelIdRef.current;
      let dispatchReservation: HermesSessionDispatchReservation | undefined =
        startingStoredSessionId ? reserveHermesSessionDispatch(startingStoredSessionId) : undefined;
      const base = isFirstMessage
        ? `${noteReferenceToken({ id: noteId, title: noteTitle })} ${question}`
        : question;
      const content = withAttachmentPaths(base, attachments);
      const optimistic: AgentChatTurn = {
        id: `note-chat-pending:${Date.now()}`,
        role: "user",
        createdAt: new Date().toISOString(),
        status: "complete",
        parts: [
          { type: "text", text: question || "Use the attached file(s).", status: "complete" },
        ],
      };
      setPendingUserTurns((current) => [...current, optimistic]);
      workingRef.current = true;
      setWorking(true);
      try {
        const gateway = await connectGateway(true);
        if (!gateway) throw new Error("Hermes gateway is not connected.");
        // Read after connectGateway so its refreshActiveHermesProfile has
        // reconciled the sticky pointer.
        const activeProfile = getActiveHermesProfileName();
        // The global default is June's model selection, not a per-chat pick.
        // Under a named profile it must not ride session.create as a
        // per-session override - that would silently bypass the profile's own
        // text model. An explicit note-chat pick still applies: the user chose
        // it for this chat.
        if (
          !capturedModelSelection &&
          defaultModelSelectionSnapshot &&
          activeProfile === "default"
        ) {
          capturedModelSelection = await defaultModelSelectionSnapshot;
          capturedHermesModelId = hermesModelIdForSelection(capturedModelSelection);
        }
        let activeStoredSessionId = startingStoredSessionId;
        let runtimeSessionId = startingRuntimeSessionId;
        if (activeStoredSessionId && !capturedModelSelection) {
          const metadata = await reconcileStoredSessionModelMetadata(activeStoredSessionId);
          if (metadata) {
            capturedModelSelection = metadata.selection;
            capturedHermesModelId = hermesModelIdForSelection(metadata.selection);
            capturedAppliedHermesModelId = metadata.appliedHermesModelId;
            if (submissionIsCurrent()) {
              appliedHermesModelIdRef.current = metadata.appliedHermesModelId;
              storedSessionMetadataHydratedRef.current = true;
              setAppliedHermesModelId(metadata.appliedHermesModelId);
            }
          }
        }
        if (!activeStoredSessionId) {
          const created = await gateway.request<HermesRuntimeSessionResponse>("session.create", {
            title: noteTitle.trim() || "Note chat",
            cols: 96,
            ...(capturedHermesModelId ? { model: capturedHermesModelId } : {}),
            ...(activeProfile !== "default" ? { profile: activeProfile } : {}),
          });
          activeStoredSessionId = created.stored_session_id ?? created.session_id;
          if (!activeStoredSessionId) throw new Error("Hermes did not create a session.");
          dispatchReservation = reserveHermesSessionDispatch(activeStoredSessionId);
          runtimeSessionId = created.session_id;
          capturedAppliedHermesModelId = capturedHermesModelId;
          if (submissionIsCurrent()) {
            appliedHermesModelIdRef.current = capturedHermesModelId;
            storedSessionMetadataHydratedRef.current = true;
            setAppliedHermesModelId(capturedHermesModelId);
            storedSessionIdRef.current = activeStoredSessionId;
            setStoredSessionId(activeStoredSessionId);
          }
          rememberNoteChatSession(noteId, activeStoredSessionId);
          if (activeProfile !== "default") {
            // The chat list scopes by the session→profile map (ADR 0031): an
            // unstamped named-profile chat would surface under default.
            await assignSessionToProfile(activeStoredSessionId, activeProfile);
          }
          const latestSelection = submissionIsCurrent()
            ? pendingModelSelectionRef.current
            : capturedModelSelection;
          if (capturedModelSelection) {
            rememberAppliedSessionModelSelection(activeStoredSessionId, capturedModelSelection);
          }
          if (
            latestSelection &&
            (!capturedModelSelection ||
              !sameSessionModelSelection(latestSelection, capturedModelSelection))
          ) {
            stageSessionModelSelection(activeStoredSessionId, latestSelection);
          }
        }
        if (!runtimeSessionId) {
          const resumed = await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
            session_id: activeStoredSessionId,
            cols: 96,
          });
          runtimeSessionId = resumed.session_id;
          if (!runtimeSessionId) throw new Error("Hermes did not resume the session.");
        }
        if (submissionIsCurrent()) runtimeSessionIdRef.current = runtimeSessionId;
        const activeDispatchReservation =
          dispatchReservation ?? reserveHermesSessionDispatch(activeStoredSessionId);
        dispatchReservation = activeDispatchReservation;
        await activeDispatchReservation.run(async () => {
          // Re-read under the shared lock. AgentWorkspace can dispatch the same
          // session from its still-mounted surface, so its accepted send may
          // have changed the live model after this NoteChat send was captured.
          const currentModelEntry = readSessionModelSelections()[activeStoredSessionId];
          const currentStoredModelId = currentModelEntry?.appliedSelection
            ? hermesModelIdForSelection(currentModelEntry.appliedSelection)
            : currentModelEntry
              ? undefined
              : capturedAppliedHermesModelId;
          const modelToApply = capturedHermesModelId;
          if (
            modelToApply &&
            (hasPendingSessionModelSelection(capturedModelEntry) ||
              activeDispatchReservation.queuedBehindPrior ||
              modelToApply !== capturedAppliedHermesModelId ||
              (currentStoredModelId !== undefined && currentStoredModelId !== modelToApply))
          ) {
            // Apply only after the session is idle/resumed and immediately ahead
            // of the prompt. Failure blocks the send; silently using the prior
            // model would betray the picker.
            await applySessionModelWhenIdle(() =>
              createHermesMethods(gateway).switchActiveSessionModel({
                mode: "sandboxed",
                sessionId: runtimeSessionId,
                model: modelToApply,
              }),
            );
            capturedAppliedHermesModelId = modelToApply;
            if (submissionIsCurrent()) {
              appliedHermesModelIdRef.current = modelToApply;
              storedSessionMetadataHydratedRef.current = true;
              setAppliedHermesModelId(modelToApply);
            }
            if (capturedModelEntry && capturedModelSelection) {
              markSessionModelSelectionApplied(
                activeStoredSessionId,
                capturedModelEntry.revision,
                capturedModelSelection,
              );
            } else if (capturedModelSelection) {
              rememberAppliedSessionModelSelection(activeStoredSessionId, capturedModelSelection);
            }
          }
          // Images go to the model as first-class inputs before the prompt,
          // like the workspace's feature-19 flow. A failed attach throws so the
          // prompt is never sent with a silently-missing image; an unsupported
          // runtime keeps the image imported and the path block still carries it.
          const pendingImages = pendingImageAttachments(
            attachments.map((attachment) => attachment.attach),
          );
          if (pendingImages.length) {
            const methods = createHermesMethods(gateway);
            const deps = {
              attachImage: methods.attachImage,
              readImageData: (path: string) => hermesBridgeImageDataUrl(path),
              isSupported: () => isHermesFeatureSupported("image.attach_bytes"),
            };
            for (const image of pendingImages) {
              const result = await attachImageToSession(image, runtimeSessionId, deps);
              if (result.state.status === "failed") {
                throw new Error(result.error ?? `Could not attach ${image.displayName}.`);
              }
            }
          }
          await gateway.request("prompt.submit", {
            session_id: runtimeSessionId,
            text: content,
          });
          startAgentRunMonitoring({
            storedSessionId: activeStoredSessionId,
            runtimeSessionId,
            title: noteTitle.trim() || "Note chat",
            fullMode: false,
            settlementHeld: false,
          });
          stoppedRuntimeSessionIdRef.current = undefined;
          stoppedRunRef.current = false;
        });
        return submissionIsCurrent();
      } catch (err) {
        dispatchReservation?.cancel();
        if (submissionIsCurrent()) {
          setPendingUserTurns((current) => current.filter((turn) => turn !== optimistic));
          workingRef.current = false;
          setWorking(false);
          setError(
            isSessionBusyError(err)
              ? "June is still working on the previous message."
              : messageFromError(err),
          );
          if (!isSessionBusyError(err)) {
            const currentStoredSessionId = storedSessionIdRef.current;
            if (currentStoredSessionId) {
              cancelAgentRunMonitoring(currentStoredSessionId);
              dispatchAgentSessionStatus({
                sessionId: currentStoredSessionId,
                title: noteTitle.trim() || "Note chat",
                status: "failed",
                summary: messageFromError(err),
              });
            }
          }
        }
        return false;
      } finally {
        if (activeSubmissionRef.current === submissionToken) {
          activeSubmissionRef.current = undefined;
          setSubmissionPending(false);
        }
      }
    },
    [noteId, noteTitle],
  );

  const stop = useCallback(() => {
    // Stopped is a UI-first state, mirroring the workspace: the moment the
    // user clicks, the turn reads as over; the interrupt follows best-effort.
    workingRef.current = false;
    setWorking(false);
    stoppedRunRef.current = true;
    const storedSessionId = storedSessionIdRef.current;
    if (storedSessionId) {
      cancelAgentRunMonitoring(storedSessionId);
      dispatchAgentSessionStatus({
        sessionId: storedSessionId,
        title: noteTitle.trim() || "Note chat",
        status: "cancelled",
        summary: "Stopped.",
      });
    }
    const runtimeSessionId = runtimeSessionIdRef.current;
    if (!runtimeSessionId) return;
    stoppedRuntimeSessionIdRef.current = runtimeSessionId;
    void (async () => {
      try {
        const gateway = await connectGateway(false);
        await gateway?.request("session.interrupt", { session_id: runtimeSessionId });
      } catch {
        // The UI already reflects stopped; a failed interrupt (gateway down)
        // must not resurrect the working state.
      } finally {
        // Pull whatever the agent persisted before the interrupt landed.
        void refreshTranscript();
      }
    })();
  }, [noteTitle, refreshTranscript]);

  const setSessionModel = useCallback((selection: SessionModelSelection) => {
    pendingModelSelectionRef.current = selection;
    setModelSelection(selection);
    const currentStoredSessionId = storedSessionIdRef.current;
    if (currentStoredSessionId) {
      stageSessionModelSelection(currentStoredSessionId, selection);
    }
  }, []);

  const turns = useMemo(() => {
    return buildHermesSessionChatTurns(messages, liveEvents, pendingUserTurns);
  }, [messages, liveEvents, pendingUserTurns]);

  return {
    turns,
    working,
    submissionPending,
    loading,
    error,
    storedSessionId,
    modelSelection,
    appliedHermesModelId,
    submit,
    stop,
    setSessionModel,
  };
}
