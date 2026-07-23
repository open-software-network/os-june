import { useEffect } from "react";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
  type AgentSessionsChangedDetail,
} from "../components/agent/AgentWorkspace";
import { assignSessionToFolder } from "../lib/tauri";
import { AGENT_SESSION_STATUS_EVENT, type AgentSessionStatusDetail } from "../lib/agent-events";
import { getActiveHermesProfileName } from "../lib/active-hermes-profile";
import { updateMenuBarSessionStatus } from "./app-effects/update-ui";
import type { UseAgentSessionSyncDependencies } from "./use-agent-session-sync-types";

export function useAgentSessionSync(dependencies: UseAgentSessionSyncDependencies) {
  const {
    activeViewRef,
    agentMenuBarLastStatusRef,
    agentMenuBarSessionsRef,
    agentMenuBarWaitingSessionIdsRef,
    agentMenuBarWorkingSessionIdsRef,
    commitAgentSessions,
    pendingSessionProjectRef,
    publishAgentMenuBarState,
    refreshSessionProfiles,
    setActiveAgentSession,
    setActiveAgentSessionId,
    setActiveAgentSessionSeed,
    setAgentOrigin,
    setAgentSessions,
    setAgentWaitingSessionIds,
    setAgentWorkingSessionIds,
    setSessionFolders,
  } = dependencies;

  useEffect(() => {
    let cancelled = false;

    function handleSessionsChanged(event: Event) {
      const detail = (event as CustomEvent<AgentSessionsChangedDetail>).detail;
      if (!detail) return;
      void refreshSessionProfiles()
        .then((profiles) => {
          if (cancelled) return;
          commitAgentSessions(detail.sessions, profiles);
        })
        .catch(() => {
          if (cancelled) return;
          commitAgentSessions(detail.sessions);
        });
      if (activeViewRef.current === "agent") {
        const selectedSessionId = detail.selectedSessionId;
        if (selectedSessionId) {
          setActiveAgentSessionId(selectedSessionId);
          setActiveAgentSessionSeed((current) =>
            current?.id === selectedSessionId ? current : undefined,
          );
        } else {
          setActiveAgentSession(undefined);
        }
      }
      // "New session" started from a project: file the first brand-new
      // session that gets selected; switching to a known session instead
      // abandons the intent.
      const pendingProject = pendingSessionProjectRef.current;
      if (pendingProject && detail.selectedSessionId) {
        pendingSessionProjectRef.current = null;
        const sessionId = detail.selectedSessionId;
        if (pendingProject.profile !== getActiveHermesProfileName()) {
          setAgentOrigin(undefined);
        } else if (!pendingProject.knownSessionIds.has(sessionId)) {
          void assignSessionToFolder(sessionId, pendingProject.folderId)
            .then(() =>
              setSessionFolders((prev) => ({
                ...prev,
                [sessionId]: [pendingProject.folderId],
              })),
            )
            .catch(() => {});
        } else {
          // User switched to an existing session — abandon the pending
          // project intent so the workspace doesn't show misleading crumbs.
          setAgentOrigin(undefined);
        }
      }
      const nextWorkingSessionIds = new Set(detail.workingSessionIds);
      const nextWaitingSessionIds = new Set(detail.waitingSessionIds ?? []);
      agentMenuBarWorkingSessionIdsRef.current = nextWorkingSessionIds;
      agentMenuBarWaitingSessionIdsRef.current = nextWaitingSessionIds;
      setAgentWorkingSessionIds(new Set(nextWorkingSessionIds));
      setAgentWaitingSessionIds(new Set(nextWaitingSessionIds));
      publishAgentMenuBarState();
    }

    function handleAgentStatusForMenuBar(event: Event) {
      const detail = (event as CustomEvent<AgentSessionStatusDetail>).detail;
      if (!detail) return;
      agentMenuBarLastStatusRef.current = detail;
      if (detail.sessionId) {
        updateMenuBarSessionStatus(detail.sessionId, detail.status, {
          working: agentMenuBarWorkingSessionIdsRef.current,
          waiting: agentMenuBarWaitingSessionIdsRef.current,
        });
        setAgentWorkingSessionIds(new Set(agentMenuBarWorkingSessionIdsRef.current));
        setAgentWaitingSessionIds(new Set(agentMenuBarWaitingSessionIdsRef.current));
      }
      publishAgentMenuBarState();
    }

    function handleAgentSessionDeleted(event: Event) {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      const sessionId = detail?.sessionId;
      if (!sessionId) return;
      agentMenuBarSessionsRef.current = agentMenuBarSessionsRef.current.filter(
        (session) => session.id !== sessionId,
      );
      setAgentSessions((current) => current.filter((session) => session.id !== sessionId));
      agentMenuBarWorkingSessionIdsRef.current.delete(sessionId);
      agentMenuBarWaitingSessionIdsRef.current.delete(sessionId);
      setAgentWorkingSessionIds(new Set(agentMenuBarWorkingSessionIdsRef.current));
      setAgentWaitingSessionIds(new Set(agentMenuBarWaitingSessionIdsRef.current));
      publishAgentMenuBarState();
    }

    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, handleSessionsChanged);
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleAgentStatusForMenuBar);
    window.addEventListener(AGENT_DELETE_SESSION_EVENT, handleAgentSessionDeleted);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_SESSIONS_CHANGED_EVENT, handleSessionsChanged);
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleAgentStatusForMenuBar);
      window.removeEventListener(AGENT_DELETE_SESSION_EVENT, handleAgentSessionDeleted);
    };
  }, [commitAgentSessions, publishAgentMenuBarState, refreshSessionProfiles]);
}
