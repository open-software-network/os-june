import { useCallback } from "react";
import { checkClovyUpdate, type ClovyUpdate } from "../lib/updater";
import {
  checkForClovyUpdate,
  prepareClovyUpdate,
  UP_TO_DATE_STATUS,
  updateCheckShowsStatus,
  type UpdateCheckMode,
  type UpdatePromptPayload,
} from "./update-decision";
import type { UseAppUpdateActionsDependencies } from "./use-app-update-actions-types";

export function useAppUpdateActions(dependencies: UseAppUpdateActionsDependencies) {
  const {
    checkingUpdateRef,
    preparingUpdateRef,
    readyUpdateRef,
    relaunchingUpdateRef,
    setCheckingUpdate,
    setPreparingUpdate,
    setReadyUpdate,
    setUpdateProgress,
    setUpdateStatus,
    updateProgressHiddenRef,
  } = dependencies;

  const prepareUpdate = useCallback(
    (payload: UpdatePromptPayload<ClovyUpdate>, mode: UpdateCheckMode) => {
      if (preparingUpdateRef.current || readyUpdateRef.current || relaunchingUpdateRef.current) {
        return;
      }

      preparingUpdateRef.current = true;
      updateProgressHiddenRef.current = false;
      setPreparingUpdate(true);
      setReadyUpdate(null);
      setUpdateProgress(null);
      setUpdateStatus(mode === "manual" ? "Downloading update..." : null);

      void prepareClovyUpdate({
        update: payload.update,
        reportProgress: (progress) => {
          setUpdateProgress(progress);
          if (mode === "manual" && !updateProgressHiddenRef.current) {
            setUpdateStatus(
              progress.state === "installing" ? "Preparing update..." : "Downloading update...",
            );
          }
        },
        reportReady: (ready) => {
          preparingUpdateRef.current = false;
          readyUpdateRef.current = ready;
          updateProgressHiddenRef.current = false;
          setPreparingUpdate(false);
          setReadyUpdate(ready);
          setUpdateProgress(null);
          setUpdateStatus(null);
        },
        reportFailure: (message) => {
          preparingUpdateRef.current = false;
          updateProgressHiddenRef.current = false;
          setPreparingUpdate(false);
          setUpdateProgress(null);
          setUpdateStatus(`Update failed: ${message}`, true);
        },
      });
    },
    [setUpdateStatus],
  );

  const runUpdateCheck = useCallback(
    // `check` defaults to the routine, forward-only check; the leave-rc reconcile
    // passes reconcileToStable so it can pull an older stable (see below).
    (mode: UpdateCheckMode, check: () => Promise<ClovyUpdate | null> = checkClovyUpdate) => {
      if (readyUpdateRef.current || relaunchingUpdateRef.current) return;
      if (checkingUpdateRef.current) return;
      if (preparingUpdateRef.current) {
        if (mode === "manual") {
          updateProgressHiddenRef.current = false;
          setUpdateStatus("Downloading update...");
        }
        return;
      }
      checkingUpdateRef.current = true;
      const showsStatus = updateCheckShowsStatus(mode);
      if (showsStatus) {
        setCheckingUpdate(true);
        setUpdateStatus("Checking for updates...");
      } else if (mode === "launch") setUpdateStatus(null);
      void checkForClovyUpdate(
        {
          check,
          prompt: (payload) => {
            prepareUpdate(payload, mode);
          },
          reportNoUpdate: () => setUpdateStatus(UP_TO_DATE_STATUS),
          reportFailure: (message) => {
            if (mode !== "periodic") {
              setUpdateStatus(`Update check failed: ${message}`, true);
            }
          },
        },
        mode,
      ).finally(() => {
        checkingUpdateRef.current = false;
        if (showsStatus) setCheckingUpdate(false);
      });
    },
    [prepareUpdate, setUpdateStatus],
  );

  return {
    runUpdateCheck,
  };
}
