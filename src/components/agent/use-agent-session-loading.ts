import { useCallback } from "react";
import { listSessionProfiles, listAgentTasks, type AgentTaskDto } from "../../lib/tauri";
import { listHermesSessions } from "../../lib/hermes-adapter";
import {
  filterAgentSessionsForProfile,
  sessionMatchesProfile,
  sessionProfileMap,
} from "../../lib/session-profile-filter";
import {
  describeHermesError,
  isHermesSessionsStartupRequestError,
  messageFromError,
} from "../../lib/errors";
import { isSessionGoneError, reportableAgentErrorOptions } from "./agent-workspace-errors";
import { mergeActiveHermesSessions } from "./session-state-helpers";
import { forgetLastOpenSessionId } from "./session-persistence";
import type { UseAgentSessionLoadingDependencies } from "./use-agent-session-loading-types";

export function useAgentSessionLoading(dependencies: UseAgentSessionLoadingDependencies) {
  const {
    activeHermesProfile,
    applySessionTitleOverrides,
    bridge,
    defaultGenerationModelIdRef,
    hermesSessionItemsRef,
    hermesSessionsHydratedRef,
    newSessionModeRef,
    pendingHermesMessagesRef,
    profileOwnedSessionIdsRef,
    restoredHermesSessionIdRef,
    selectedHermesSessionIdRef,
    selectedTask,
    setError,
    setHermesSessionItems,
    setHermesSessionsHydrated,
    setHermesSessionsLoading,
    setLoading,
    setSelectedHermesSessionId,
    setSelectedTaskId,
    setTasks,
    waitingSessionIdsRef,
    workingSessionIdsRef,
  } = dependencies;

  const upsertTask = useCallback((task: AgentTaskDto) => {
    setTasks((prev) => {
      const rest = prev.filter((item) => item.id !== task.id);
      return [task, ...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const response = await listAgentTasks();
      setTasks(response.items);
      setSelectedTaskId((current) =>
        newSessionModeRef.current ? undefined : (current ?? response.items[0]?.id),
      );
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHermesSessions = useCallback(
    async (
      options: { suppressStartupRequestError?: boolean; suppressSessionGoneError?: boolean } = {},
    ) => {
      if (!bridge.running || !activeHermesProfile.confirmed) return "skipped";
      let keepLoading = false;
      setHermesSessionsLoading(true);
      try {
        const [listedSessions, assignments] = await Promise.all([
          listHermesSessions(),
          listSessionProfiles(),
        ]);
        const profiles = sessionProfileMap(assignments);
        const activeProfile = activeHermesProfile.name;
        const sessions = applySessionTitleOverrides(
          filterAgentSessionsForProfile(listedSessions, profiles, activeProfile),
        );
        profileOwnedSessionIdsRef.current = new Set(
          activeProfile === "default"
            ? []
            : assignments
                .filter((assignment) => assignment.profile === activeProfile)
                .map((assignment) => assignment.sessionId),
        );
        hermesSessionsHydratedRef.current = true;
        setHermesSessionsHydrated(true);
        const pendingMessages = pendingHermesMessagesRef.current;
        const selectedSessionId = selectedHermesSessionIdRef.current;
        const selectedProfileSessionId =
          selectedSessionId &&
          sessionMatchesProfile({ id: selectedSessionId }, profiles, activeProfile)
            ? selectedSessionId
            : undefined;
        const workingSessions = workingSessionIdsRef.current;
        const waitingSessions = waitingSessionIdsRef.current;
        const currentProfileSessionIds = new Set(
          hermesSessionItemsRef.current
            .filter((session) => sessionMatchesProfile(session, profiles, activeProfile))
            .map((session) => session.id),
        );
        setHermesSessionItems((current) =>
          mergeActiveHermesSessions(
            sessions,
            current.filter((session) => sessionMatchesProfile(session, profiles, activeProfile)),
            {
              selectedSessionId: selectedProfileSessionId,
              workingSessionIds: workingSessions,
              waitingSessionIds: waitingSessions,
              pendingMessages,
              defaultModelId: defaultGenerationModelIdRef.current,
            },
          ),
        );
        const restoredSessionId = restoredHermesSessionIdRef.current;
        restoredHermesSessionIdRef.current = undefined;
        setSelectedHermesSessionId((current) => {
          if (newSessionModeRef.current) {
            selectedHermesSessionIdRef.current = undefined;
            return undefined;
          }
          let candidate = current ?? restoredSessionId;
          const candidateIsCurrent = candidate !== undefined && candidate === current;
          if (candidate && !sessionMatchesProfile({ id: candidate }, profiles, activeProfile)) {
            forgetLastOpenSessionId(candidate);
            candidate = undefined;
          }
          if (
            candidate &&
            (sessions.some((session) => session.id === candidate) ||
              candidateIsCurrent ||
              currentProfileSessionIds.has(candidate))
          ) {
            selectedHermesSessionIdRef.current = candidate;
            return candidate;
          }
          if (restoredSessionId && candidate === restoredSessionId) {
            forgetLastOpenSessionId(restoredSessionId);
          }
          const taskSession = selectedTask?.hermesSessionId;
          if (taskSession && sessions.some((session) => session.id === taskSession)) {
            selectedHermesSessionIdRef.current = taskSession;
            return taskSession;
          }
          const nextSessionId = sessions[0]?.id;
          selectedHermesSessionIdRef.current = nextSessionId;
          return nextSessionId;
        });
        // Deliberately no setError(null) here: this runs from background polls,
        // so a success would wipe an unrelated banner (e.g. a failed send)
        // moments after it appeared. The banner is dismissable instead.
        return "loaded";
      } catch (err) {
        const message = messageFromError(err);
        if (
          options.suppressStartupRequestError &&
          !hermesSessionsHydratedRef.current &&
          isHermesSessionsStartupRequestError(err)
        ) {
          keepLoading = true;
          return "transient-startup-error";
        }
        if (options.suppressSessionGoneError && isSessionGoneError(message)) {
          return "failed";
        }
        setError(describeHermesError(err), reportableAgentErrorOptions(err));
        return "failed";
      } finally {
        if (!keepLoading) {
          setHermesSessionsLoading(false);
        }
      }
    },
    [
      activeHermesProfile.confirmed,
      activeHermesProfile.name,
      bridge.running,
      selectedTask?.hermesSessionId,
    ],
  );

  return {
    upsertTask,
    loadTasks,
    loadHermesSessions,
  };
}
