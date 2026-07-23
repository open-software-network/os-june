import { useEffect } from "react";
import { dispatchAgentSessionsChanged } from "../../lib/agent-events";
import { isProvisionalHermesSessionId } from "./agent-workspace-config";
import type { UseSessionListBroadcastDependencies } from "./use-session-list-broadcast-types";

export function useSessionListBroadcast(dependencies: UseSessionListBroadcastDependencies) {
  const {
    hermesSessionItems,
    hermesSessionsHydrated,
    selectedHermesSessionId,
    waitingSessionIds,
    workingSessionIds,
  } = dependencies;

  useEffect(() => {
    // The sidebar and App replace their session lists wholesale with this
    // payload, so an unhydrated broadcast (mount seed only) would collapse
    // the list they already fetched themselves and flicker it back once the
    // real fetch lands.
    if (!hermesSessionsHydrated) return;
    dispatchAgentSessionsChanged({
      sessions: hermesSessionItems.filter((session) => !isProvisionalHermesSessionId(session.id)),
      selectedSessionId: isProvisionalHermesSessionId(selectedHermesSessionId)
        ? undefined
        : selectedHermesSessionId,
      workingSessionIds: Array.from(workingSessionIds).filter(
        (sessionId) => !isProvisionalHermesSessionId(sessionId),
      ),
      waitingSessionIds: Array.from(waitingSessionIds).filter(
        (sessionId) => !isProvisionalHermesSessionId(sessionId),
      ),
    });
  }, [
    hermesSessionsHydrated,
    hermesSessionItems,
    selectedHermesSessionId,
    waitingSessionIds,
    workingSessionIds,
  ]);
}
