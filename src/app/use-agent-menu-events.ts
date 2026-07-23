import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import {
  AGENT_NEW_SESSION_EVENT,
  markAgentNewSessionPending,
  type AgentNewSessionDetail,
} from "../components/agent/AgentWorkspace";
import { listAgentSessions } from "../lib/tauri";
import {
  AGENT_MENU_BAR_NEW_SESSION_EVENT,
  AGENT_MENU_BAR_OPEN_SESSION_EVENT,
  AGENT_MENU_BAR_SET_AGENT_HUD_EVENT,
} from "../lib/menu-bar";
import type { UseAgentMenuEventsDependencies } from "./use-agent-menu-events-types";

export function useAgentMenuEvents(dependencies: UseAgentMenuEventsDependencies) {
  const {
    agentMenuBarSessionsRef,
    handleAgentHudVisibilityRequest,
    pendingSessionProjectRef,
    profileScopedAgentSessions,
    publishAgentMenuBarState,
    refreshSessionProfiles,
    setActiveAgentSession,
    setActiveAgentSessionId,
    setActiveAgentSessionSeed,
    setActiveView,
    setAgentOrigin,
  } = dependencies;

  useEffect(() => {
    let aborted = false;
    const unlisteners: Array<() => void> = [];

    async function installMenuBarListener<T>(eventName: string, handler: (payload: T) => void) {
      try {
        const cleanup = await listen<T>(eventName, (event) => handler(event.payload));
        if (aborted) cleanup();
        else unlisteners.push(cleanup);
      } catch {
        // Native menu-bar events only exist inside the Tauri shell.
      }
    }

    void installMenuBarListener<void>(AGENT_MENU_BAR_NEW_SESSION_EVENT, () => {
      pendingSessionProjectRef.current = null;
      setAgentOrigin(undefined);
      markAgentNewSessionPending();
      setActiveAgentSession(undefined);
      setActiveView("agent");
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT));
      }, 0);
    });

    void installMenuBarListener<string>(AGENT_MENU_BAR_OPEN_SESSION_EVENT, (sessionId) => {
      setAgentOrigin(undefined);
      if (!sessionId) {
        setActiveAgentSession(undefined);
        setActiveView("agent");
        return;
      }
      setActiveAgentSessionId(sessionId);
      setActiveAgentSessionSeed(undefined);
      const cachedSession = agentMenuBarSessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (cachedSession) {
        setActiveAgentSession(cachedSession);
        setActiveView("agent");
        return;
      }
      void Promise.all([listAgentSessions(), refreshSessionProfiles()])
        .then(([sessions, profiles]) => {
          const scopedSessions = profileScopedAgentSessions(sessions, profiles);
          agentMenuBarSessionsRef.current = scopedSessions;
          const session = scopedSessions.find((item) => item.id === sessionId);
          if (session) setActiveAgentSession(session);
          setActiveView("agent");
          publishAgentMenuBarState();
        })
        .catch(() => {
          setActiveView("agent");
        });
    });

    void installMenuBarListener<boolean>(
      AGENT_MENU_BAR_SET_AGENT_HUD_EVENT,
      handleAgentHudVisibilityRequest,
    );

    return () => {
      aborted = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [
    handleAgentHudVisibilityRequest,
    profileScopedAgentSessions,
    publishAgentMenuBarState,
    refreshSessionProfiles,
  ]);
}
