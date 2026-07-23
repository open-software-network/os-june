import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { agentOpenReady } from "../lib/tauri";
import { AGENT_OPEN_EVENT } from "../lib/agent-events";
import { listAgentSessions } from "../lib/tauri";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";
import type { UseAppExternalEventsDependencies } from "./use-app-external-events-types";

export function useAppExternalEvents(dependencies: UseAppExternalEventsDependencies) {
  const { agentMenuBarSessionsRef, setActiveAgentSession, setActiveView, setAgentOrigin } =
    dependencies;

  useEffect(() => {
    let aborted = false;

    function openAgentWorkspace(session?: AgentSessionDto) {
      setAgentOrigin(undefined);
      setActiveAgentSession(session);
      setActiveView("agent");
    }

    // Notification clicks carry only a session id (the session may have
    // changed since the notification was posted). Resolve it against the
    // known sessions, refreshing from the bridge when it is not cached. The
    // workspace opens immediately for feedback and upgrades to the chat when
    // the lookup lands; a session that no longer exists stays on the agent
    // view rather than dropping the click on an unrelated one. The sequence
    // counter keeps a slow lookup for an older click from overriding a newer
    // one. A cold start can reach this before the the retired runtime bridge is up, so a
    // failed listing (as opposed to a successful listing that lacks the id)
    // retries while the bridge boots instead of eating the click.
    const sessionLookupAttempts = 20;
    const sessionLookupRetryMs = 1_000;
    let openSequence = 0;
    async function openAgentSessionById(sessionId: string) {
      openSequence += 1;
      const sequence = openSequence;
      const cached = agentMenuBarSessionsRef.current.find((session) => session.id === sessionId);
      if (cached) {
        openAgentWorkspace(cached);
        return;
      }
      openAgentWorkspace(undefined);
      for (let attempt = 0; attempt < sessionLookupAttempts; attempt += 1) {
        let sessions: AgentSessionDto[];
        try {
          sessions = await listAgentSessions();
        } catch {
          await new Promise((resolve) => window.setTimeout(resolve, sessionLookupRetryMs));
          if (aborted || sequence !== openSequence) return;
          continue;
        }
        if (aborted || sequence !== openSequence) return;
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (session) openAgentWorkspace(session);
        return;
      }
    }

    function handleOpenPayload(payload?: { session?: AgentSessionDto; sessionId?: string }) {
      if (payload?.session) {
        openAgentWorkspace(payload.session);
        return;
      }
      if (payload?.sessionId) {
        void openAgentSessionById(payload.sessionId);
        // The backend keeps the clicked session queued in case the emit
        // raced a webview reload; this event was received, so drain it.
        void agentOpenReady().catch(() => {});
        return;
      }
      openAgentWorkspace(undefined);
    }

    function handleOpenEvent(event: Event) {
      handleOpenPayload(
        (event as CustomEvent<{ session?: AgentSessionDto; sessionId?: string }>).detail,
      );
    }

    let unlisten: (() => void) | undefined;
    window.addEventListener(AGENT_OPEN_EVENT, handleOpenEvent);
    void listen<{ session?: AgentSessionDto; sessionId?: string }>(AGENT_OPEN_EVENT, (event) => {
      handleOpenPayload(event.payload);
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });

    // Listeners are registered; drain a notification click that launched the
    // app before the webview could hear the open event.
    void agentOpenReady()
      .then((sessionId) => {
        if (!aborted && sessionId) void openAgentSessionById(sessionId);
      })
      .catch(() => {});

    return () => {
      aborted = true;
      unlisten?.();
      window.removeEventListener(AGENT_OPEN_EVENT, handleOpenEvent);
    };
  }, []);
}
