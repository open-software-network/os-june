import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import {
  acknowledgeMeetingEndFinishRequest,
  pendingMeetingEndFinishRequest,
  pendingMeetingEndStatus,
  type MeetingEndStatus,
} from "../lib/tauri";
import { MEETING_END_FINISH_REQUEST_EVENT, MEETING_END_STATE_EVENT } from "../lib/events";
import type * as React from "react";

type Dependencies = {
  drainPendingFinishRef: React.MutableRefObject<() => void>;
  finishHandlerRef: React.MutableRefObject<(sessionId: string) => Promise<boolean>>;
  listenerRegisteredRef: React.MutableRefObject<boolean>;
  readyRef: React.MutableRefObject<boolean>;
  setStatus: React.Dispatch<React.SetStateAction<MeetingEndStatus | null>>;
};

export function useMeetingEndEvents({
  drainPendingFinishRef,
  finishHandlerRef,
  listenerRegisteredRef,
  readyRef,
  setStatus,
}: Dependencies) {
  useEffect(() => {
    let aborted = false;
    let unlistenState: (() => void) | undefined;
    let unlistenFinish: (() => void) | undefined;
    let listenerRetryTimer: number | undefined;
    let drainRetryTimer: number | undefined;
    let drainRunning = false;
    let drainAgain = false;
    let stateEventRevision = 0;

    const scheduleDrainRetry = () => {
      if (aborted || drainRetryTimer !== undefined) return;
      drainRetryTimer = window.setTimeout(() => {
        drainRetryTimer = undefined;
        drainPendingFinish();
      }, 500);
    };

    function drainPendingFinish() {
      if (!readyRef.current || !listenerRegisteredRef.current) return;
      if (drainRunning) {
        drainAgain = true;
        return;
      }
      drainRunning = true;
      void (async () => {
        let shouldRetry = false;
        try {
          const request = await pendingMeetingEndFinishRequest();
          if (aborted || !readyRef.current || !listenerRegisteredRef.current || !request) {
            return;
          }
          const attempted = await finishHandlerRef.current(request.sessionId);
          if (!attempted) {
            shouldRetry = true;
            return;
          }
          const acknowledged = await acknowledgeMeetingEndFinishRequest(request.requestId);
          shouldRetry = !acknowledged;
        } catch {
          shouldRetry = true;
        } finally {
          drainRunning = false;
          if (!aborted) {
            if (drainAgain) {
              drainAgain = false;
              drainPendingFinish();
            } else if (shouldRetry) {
              scheduleDrainRetry();
            }
          }
        }
      })();
    }

    drainPendingFinishRef.current = drainPendingFinish;
    const register = (attempt = 0) => {
      void (async () => {
        let cleanupState: (() => void) | undefined;
        let cleanupFinish: (() => void) | undefined;
        try {
          const [stateRegistration, finishRegistration] = await Promise.allSettled([
            listen<MeetingEndStatus | null>(MEETING_END_STATE_EVENT, (event) => {
              stateEventRevision += 1;
              setStatus(event.payload ?? null);
            }),
            listen(MEETING_END_FINISH_REQUEST_EVENT, drainPendingFinish),
          ]);
          cleanupState =
            stateRegistration.status === "fulfilled" ? stateRegistration.value : undefined;
          cleanupFinish =
            finishRegistration.status === "fulfilled" ? finishRegistration.value : undefined;
          if (stateRegistration.status === "rejected") throw stateRegistration.reason;
          if (finishRegistration.status === "rejected") throw finishRegistration.reason;
          if (aborted) {
            stateRegistration.value();
            finishRegistration.value();
            return;
          }
          unlistenState = stateRegistration.value;
          unlistenFinish = finishRegistration.value;
          listenerRegisteredRef.current = true;
          const revisionBeforeInitialRead = stateEventRevision;
          void pendingMeetingEndStatus()
            .then((status) => {
              if (!aborted && stateEventRevision === revisionBeforeInitialRead) {
                setStatus(status);
              }
            })
            .catch(() => undefined);
          drainPendingFinish();
        } catch {
          cleanupState?.();
          cleanupFinish?.();
          if (!aborted) {
            const retryDelay = Math.min(250 * 2 ** attempt, 2_000);
            listenerRetryTimer = window.setTimeout(() => register(attempt + 1), retryDelay);
          }
        }
      })();
    };

    register();
    return () => {
      aborted = true;
      listenerRegisteredRef.current = false;
      if (listenerRetryTimer !== undefined) window.clearTimeout(listenerRetryTimer);
      if (drainRetryTimer !== undefined) window.clearTimeout(drainRetryTimer);
      unlistenState?.();
      unlistenFinish?.();
    };
  }, [drainPendingFinishRef, finishHandlerRef, listenerRegisteredRef, readyRef, setStatus]);
}
