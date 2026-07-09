import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildHermesSessionChatTurns, type AgentChatTurn } from "../../lib/agent-chat-runtime";
import { messageFromError } from "../../lib/errors";
import { hermesConnectionForMode } from "../../lib/hermes-connection";
import { classifyHermesEvent } from "../../lib/hermes-control-plane/event-classifier";
import { createHermesMethods } from "../../lib/hermes-control-plane/methods";
import { isTerminalHermesEvent, type JuneHermesEvent } from "../../lib/hermes-control-plane/events";
import { isHermesFeatureSupported } from "../../lib/hermes-control-plane/compatibility/support";
import { HermesGatewayClient, isSessionBusyError } from "../../lib/hermes-gateway";
import {
  attachImageToSession,
  pendingImageAttachments,
  type HermesAttachmentState,
} from "../../lib/hermes-image-attach";
import {
  ensureHermesBridgeSession,
  hermesBridgeImageDataUrl,
  hermesBridgeSessionMessages,
  hermesBridgeStatus,
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

export type NoteChat = {
  /** The rendered conversation: persisted turns + the live streaming tail. */
  turns: AgentChatTurn[];
  /** True from an accepted submit until the turn's terminal event. */
  working: boolean;
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
  /** Interrupts the running turn. The UI reads stopped immediately; the
   * interrupt RPC follows best-effort, like the workspace's stop. */
  stop: () => void;
  /** Chooses the model for this chat: applied at session.create for a fresh
   * chat, or as a /model switch ahead of the next message on a live one. */
  setSessionModel: (modelId: string) => void;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const storedSessionIdRef = useRef<string>();
  const runtimeSessionIdRef = useRef<string>();
  // The model the user picked in the panel vs the one the live session runs.
  // They converge at session.create (fresh chat) or via a /model dispatch
  // right before the next prompt (existing chat) — never mid-turn.
  const pendingModelIdRef = useRef<string>();
  const appliedModelIdRef = useRef<string>();
  // Synchronous in-flight guard: React batches setWorking(true), so a rapid
  // double send (double-click, or Enter racing the send button) could both
  // pass the state-based check and each create a session / append a turn.
  const submittingRef = useRef(false);
  // Whether this session is registered in the bridge's session LIST. The
  // conversation itself always loads by session id (the agent view reads
  // messages by id, and this ensure is best-effort — mirroring the workspace's
  // own swallowed ensure), so registration only affects the history sidebar.
  // Retried on later sends and backfilled at the open-in-agent handoff.
  const bridgeEnsuredRef = useRef(false);
  const liveEventsRef = useRef<JuneHermesEvent[]>([]);
  const pendingUserTurnsRef = useRef<AgentChatTurn[]>([]);
  liveEventsRef.current = liveEvents;
  pendingUserTurnsRef.current = pendingUserTurns;

  // Rebind to the note's session whenever the panel switches notes.
  useEffect(() => {
    const sessionId = noteId ? noteChatSessionIdFor(noteId) : undefined;
    storedSessionIdRef.current = sessionId;
    runtimeSessionIdRef.current = undefined;
    pendingModelIdRef.current = undefined;
    appliedModelIdRef.current = undefined;
    submittingRef.current = false;
    bridgeEnsuredRef.current = false;
    setStoredSessionId(sessionId);
    setMessages([]);
    setLiveEvents([]);
    setPendingUserTurns([]);
    setWorking(false);
    setError(null);
    if (!sessionId) {
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
      const response = await hermesBridgeSessionMessages(sessionId);
      if (stale) return;
      setMessages(sessionMessagesFrom(response));
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

  const refreshTranscript = useCallback(async () => {
    const sessionId = storedSessionIdRef.current;
    if (!sessionId) return;
    // Snapshot how much live state this refresh supersedes: events that land
    // while the fetch is in flight belong to a newer beat and must survive it.
    const supersededEvents = liveEventsRef.current.length;
    const supersededPending = pendingUserTurnsRef.current.length;
    try {
      const response = await hermesBridgeSessionMessages(sessionId);
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
      const sessionId = "sessionId" in event ? event.sessionId : undefined;
      const matchesSession =
        sessionId === runtimeSessionIdRef.current || sessionId === storedSessionIdRef.current;
      const terminal = isTerminalHermesEvent(event);
      // A tagged event for a different session isn't ours. A terminal frame
      // can arrive WITHOUT a session id (error / lifecycle), though — and this
      // gateway only ever serves the one active note chat, so an untagged
      // terminal event can only mean our in-flight turn ended: clear `working`
      // so the toolbar dot can't stick busy. Untagged non-terminal events stay
      // dropped (they can't be attributed to our transcript).
      if (sessionId && !matchesSession) return;
      if (!sessionId && !terminal) return;
      if (matchesSession) {
        setLiveEvents((current) => [...current, event].slice(-LIVE_EVENT_CAP));
      }
      if (terminal) {
        setWorking(false);
        if (event.kind === "error") {
          setError(event.message);
        } else if (matchesSession) {
          void refreshTranscript();
        }
      }
    });
  }, [refreshTranscript]);

  const submit = useCallback(
    async (rawText: string, attachments: NoteChatAttachment[] = []): Promise<boolean> => {
      const question = rawText.trim();
      if ((!question && !attachments.length) || !noteId) return false;
      // Reject a second send that races the first before setWorking(true)
      // commits — otherwise both could create a session and submit the prompt.
      if (submittingRef.current) return false;
      submittingRef.current = true;
      setError(null);
      const isFirstMessage = !storedSessionIdRef.current;
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
      setWorking(true);
      try {
        const gateway = await connectGateway(true);
        if (!gateway) throw new Error("Hermes gateway is not connected.");
        let sessionId = storedSessionIdRef.current;
        let runtimeSessionId = runtimeSessionIdRef.current;
        const modelId = pendingModelIdRef.current;
        if (!sessionId) {
          const created = await gateway.request<HermesRuntimeSessionResponse>("session.create", {
            title: noteTitle.trim() || "Note chat",
            cols: 96,
            ...(modelId ? { model: modelId } : {}),
          });
          sessionId = created.stored_session_id ?? created.session_id;
          if (!sessionId) throw new Error("Hermes did not create a session.");
          runtimeSessionId = created.session_id;
          appliedModelIdRef.current = modelId;
          storedSessionIdRef.current = sessionId;
          setStoredSessionId(sessionId);
          rememberNoteChatSession(noteId, sessionId);
          // Registration in the bridge list happens at the single ensure point
          // below (which retries a swallowed attempt on later sends).
        }
        if (!runtimeSessionId) {
          const resumed = await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
            session_id: sessionId,
            cols: 96,
          });
          runtimeSessionId = resumed.session_id;
          if (!runtimeSessionId) throw new Error("Hermes did not resume the session.");
        }
        runtimeSessionIdRef.current = runtimeSessionId;
        if (modelId && modelId !== appliedModelIdRef.current) {
          // A picked model on an existing session applies as the same /model
          // dispatch the workspace uses, ahead of the prompt so this turn
          // already runs on it. Failure surfaces like any submit error —
          // sending on the wrong model silently would betray the picker.
          await createHermesMethods(gateway).switchActiveSessionModel({
            mode: "sandboxed",
            sessionId: runtimeSessionId,
            model: modelId,
          });
          appliedModelIdRef.current = modelId;
          bridgeEnsuredRef.current = await ensureHermesBridgeSession({
            sessionId,
            title: noteTitle.trim() || "Note chat",
            model: modelId,
          })
            .then(() => true)
            .catch(() => bridgeEnsuredRef.current);
        }
        // Best-effort registration in the bridge's session list (for the
        // history sidebar), retrying a swallowed earlier attempt. The chat and
        // the open-in-agent handoff both work by session id regardless.
        if (!bridgeEnsuredRef.current) {
          bridgeEnsuredRef.current = await ensureHermesBridgeSession({
            sessionId,
            title: noteTitle.trim() || "Note chat",
            ...(appliedModelIdRef.current ? { model: appliedModelIdRef.current } : {}),
          })
            .then(() => true)
            .catch(() => false);
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
        return true;
      } catch (err) {
        setPendingUserTurns((current) => current.filter((turn) => turn !== optimistic));
        setWorking(false);
        setError(
          isSessionBusyError(err)
            ? "June is still working on the previous message."
            : messageFromError(err),
        );
        return false;
      } finally {
        submittingRef.current = false;
      }
    },
    [noteId, noteTitle],
  );

  const stop = useCallback(() => {
    // Stopped is a UI-first state, mirroring the workspace: the moment the
    // user clicks, the turn reads as over; the interrupt follows best-effort.
    setWorking(false);
    const runtimeSessionId = runtimeSessionIdRef.current;
    if (!runtimeSessionId) return;
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
  }, [refreshTranscript]);

  const setSessionModel = useCallback((modelId: string) => {
    pendingModelIdRef.current = modelId;
  }, []);

  const turns = useMemo(() => {
    const built = buildHermesSessionChatTurns(messages, liveEvents);
    if (!pendingUserTurns.length) return built;
    return [...built, ...pendingUserTurns].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [messages, liveEvents, pendingUserTurns]);

  return {
    turns,
    working,
    loading,
    error,
    storedSessionId,
    submit,
    stop,
    setSessionModel,
  };
}
