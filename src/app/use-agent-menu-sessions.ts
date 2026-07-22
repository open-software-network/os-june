import { useEffect } from "react";
import { sendAppNotification } from "../lib/tauri";
import { listScheduledRunSessions } from "../lib/hermes-adapter";
import {
  createSingleFlight,
  loadRoutineRunWatchState,
  markRunsNotified,
  routineRunWatchStep,
  saveRoutineRunWatchState,
} from "../lib/routine-run-notifications";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import type { HermesSessionInfo } from "../lib/tauri";
import { ROUTINE_RUN_NOTIFY_POLL_MS } from "./app-shell";
import type { useAgentMenuSessionsDependencies } from "./use-agent-menu-sessions-types";

export function useAgentMenuSessions(dependencies: useAgentMenuSessionsDependencies) {
  const { appBlocked, bootstrapped } = dependencies;

  useEffect(() => {
    if (appBlocked || !bootstrapped) return;
    let cancelled = false;
    let state = loadRoutineRunWatchState();
    const runSingleFlight = createSingleFlight();

    async function notificationPermissionGranted() {
      let granted = await isPermissionGranted().catch(() => false);
      if (!granted) {
        const permission = await requestPermission().catch(() => "denied" as const);
        granted = permission === "granted";
      }
      return granted;
    }

    async function poll() {
      await runSingleFlight(async () => {
        let sessions: HermesSessionInfo[];
        try {
          sessions = await listScheduledRunSessions({ includeActive: true });
        } catch {
          // Bridge down (asleep, restarting): try again next tick.
          return;
        }
        if (cancelled) return;
        const { next, notices } = routineRunWatchStep(state, sessions, Date.now());
        state = next;
        if (notices.length === 0) {
          saveRoutineRunWatchState(state);
          return;
        }
        // Match agent/recording notification paths: ask for permission before
        // sending, and only mark delivered after a successful send so a denied
        // or failed delivery can retry while the run is still fresh.
        if (!(await notificationPermissionGranted())) {
          saveRoutineRunWatchState(state);
          return;
        }
        if (cancelled) return;
        const delivered: string[] = [];
        await Promise.all(
          notices.map((notice) =>
            sendAppNotification({
              title: notice.title,
              body: notice.body,
              sound: "Ping",
              group: notice.jobId ? `june-routine-${notice.jobId}` : "june-routine",
              sessionId: notice.sessionId,
            })
              .then(() => delivered.push(notice.sessionId))
              .catch(() => {}),
          ),
        );
        state = markRunsNotified(state, delivered);
        saveRoutineRunWatchState(state);
      });
    }

    void poll();
    const timer = window.setInterval(() => void poll(), ROUTINE_RUN_NOTIFY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [appBlocked, bootstrapped]);
}
