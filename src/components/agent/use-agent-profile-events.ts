import { useEffect } from "react";
import { AGENT_DELETE_SESSION_EVENT, AGENT_NEW_SESSION_EVENT } from "../../lib/agent-events";
import {
  AGENT_SESSION_RENAMED_EVENT,
  type AgentSessionRenamedDetail,
} from "./agent-workspace-config";
import { pendingNewSessionRequest, type AgentNewSessionDetail } from "./session-persistence";
import type { AgentDeleteSessionDetail } from "./agent-workspace-models";
import type { useAgentProfileEventsDependencies } from "./use-agent-profile-events-types";

export function useAgentProfileEvents(dependencies: useAgentProfileEventsDependencies) {
  const { windowEventHandlersRef } = dependencies;

  useEffect(() => {
    function handleNewSession(event: Event) {
      const detail = (event as CustomEvent<AgentNewSessionDetail>).detail;
      void windowEventHandlersRef.current.startNewTask(detail);
    }

    function handleDeleteSession(event: Event) {
      const detail = (event as CustomEvent<AgentDeleteSessionDetail>).detail;
      if (!detail?.sessionId) return;
      windowEventHandlersRef.current.removeHermesSessionLocally(detail.sessionId);
    }

    function handleRenameSession(event: Event) {
      const detail = (event as CustomEvent<AgentSessionRenamedDetail>).detail;
      if (!detail?.sessionId) return;
      windowEventHandlersRef.current.applyManualHermesSessionTitleLocally(
        detail.sessionId,
        detail.title,
      );
    }

    const pending = pendingNewSessionRequest();
    if (pending) {
      void windowEventHandlersRef.current.startNewTask(pending, {
        deferSeed: true,
      });
    }

    window.addEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
    window.addEventListener(AGENT_DELETE_SESSION_EVENT, handleDeleteSession);
    window.addEventListener(AGENT_SESSION_RENAMED_EVENT, handleRenameSession);
    return () => {
      window.removeEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
      window.removeEventListener(AGENT_DELETE_SESSION_EVENT, handleDeleteSession);
      window.removeEventListener(AGENT_SESSION_RENAMED_EVENT, handleRenameSession);
    };
  }, []);
}
