import {
  computerUseEndRun,
  setLocalGenerationEnabled,
  setCostQuality,
  setVeniceModel,
  type HermesSessionInfo,
  type HermesSessionMessage,
} from "../../lib/tauri";
import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import { hermesActivityStore } from "../../lib/hermes-activity-store";
import { dispatchProviderModelSettingsChanged } from "../../lib/model-privacy";
import {
  forgetSessionModelSelection,
  migrateSessionModelSelection,
  type SessionModelSelection,
} from "../../lib/hermes-session-model-selection";
import { LOCAL_GENERATION_OPTION_ID_PREFIX } from "../../lib/local-generation";
import { AUTO_MODEL_ID } from "../settings/ModelPickerDialog";
import { makeProvisionalHermesSessionId } from "./agent-workspace-config";
import {
  moveComposerDraft,
  sessionComposerDraftKey,
  NEW_SESSION_DRAFT_KEY,
} from "./agent-session-continuity";
import { moveRecordKey, omitRecordKey } from "./agent-workspace-support";
import type { createOptimisticSessionActionsDependencies } from "./optimistic-session-actions-types";

export function createOptimisticSessionActions(
  dependencies: createOptimisticSessionActionsDependencies,
) {
  const {
    commitSessionModelSelections,
    composerDraftKeyRef,
    computerUseRunLeasesRef,
    defaultGenerationModelIdRef,
    generationCostQualityRef,
    generationSelectionIntentRevisionRef,
    hermesSessionMessagesRef,
    heroExitViaThreadRef,
    liveEventsRef,
    newSessionModeRef,
    pendingHermesMessagesRef,
    recordSessionRunningActivity,
    saveGenerationSelection,
    selectedHermesSessionIdRef,
    sessionModelSelectionsRef,
    setDefaultGenerationModelId,
    setGenerationCostQuality,
    setHermesSessionItems,
    setHermesSessionMessages,
    setLiveEvents,
    setNewSessionMode,
    setPendingHermesMessages,
    setSelectedHermesSessionId,
    setSelectedTaskId,
  } = dependencies;

  function startOptimisticHermesSession({
    displayContent,
    model,
    title,
  }: {
    displayContent: string;
    model?: string;
    title: string;
  }) {
    const sessionId = makeProvisionalHermesSessionId();
    moveComposerDraft(NEW_SESSION_DRAFT_KEY, sessionComposerDraftKey(sessionId));
    const createdAt = new Date().toISOString();
    const userMessage: HermesSessionMessage = {
      id: `pending:user:${Date.now()}`,
      role: "user",
      content: displayContent,
      timestamp: createdAt,
    };
    heroExitViaThreadRef.current = true;
    newSessionModeRef.current = false;
    setNewSessionMode(false);
    selectedHermesSessionIdRef.current = sessionId;
    setSelectedHermesSessionId(sessionId);
    setSelectedTaskId(undefined);
    setHermesSessionItems((current) => [
      {
        id: sessionId,
        title,
        preview: displayContent,
        started_at: createdAt,
        last_active: createdAt,
        message_count: 1,
        ...(model ? { model } : {}),
      },
      ...current,
    ]);
    setPendingHermesMessages((current) => {
      const next = {
        ...current,
        [sessionId]: [...(current[sessionId] ?? []), userMessage],
      };
      pendingHermesMessagesRef.current = next;
      return next;
    });
    recordSessionRunningActivity(sessionId);
    dispatchAgentSessionStatus({
      title,
      prompt: displayContent,
      status: "starting",
      summary: "Starting June.",
    });
    return { createdAt, id: sessionId, userMessage };
  }

  function migrateOptimisticHermesSession({
    clearModel,
    createdAt,
    displayContent,
    fromSessionId,
    model,
    title,
    toSessionId,
  }: {
    clearModel?: boolean;
    createdAt: string;
    displayContent: string;
    fromSessionId: string;
    model?: string;
    title: string;
    toSessionId: string;
  }) {
    if (fromSessionId === toSessionId) return;
    moveComposerDraft(sessionComposerDraftKey(fromSessionId), sessionComposerDraftKey(toSessionId));
    commitSessionModelSelections(migrateSessionModelSelection(fromSessionId, toSessionId));
    setHermesSessionItems((current) => {
      const replacement: HermesSessionInfo = {
        id: toSessionId,
        title,
        preview: displayContent,
        started_at: createdAt,
        last_active: createdAt,
        message_count: 1,
        ...(clearModel ? { model: undefined } : model ? { model } : {}),
      };
      let replaced = false;
      const next = current.flatMap((session) => {
        if (session.id === toSessionId) return [];
        if (session.id === fromSessionId) {
          replaced = true;
          return [{ ...session, ...replacement }];
        }
        return [session];
      });
      return replaced ? next : [replacement, ...next];
    });
    setHermesSessionMessages((current) => {
      const next = moveRecordKey(current, fromSessionId, toSessionId);
      hermesSessionMessagesRef.current = next;
      return next;
    });
    setPendingHermesMessages((current) => {
      const next = moveRecordKey(current, fromSessionId, toSessionId);
      pendingHermesMessagesRef.current = next;
      return next;
    });
    liveEventsRef.current = moveRecordKey(liveEventsRef.current, fromSessionId, toSessionId);
    setLiveEvents(liveEventsRef.current);
    hermesActivityStore.clearSession(fromSessionId);
    recordSessionRunningActivity(toSessionId);
    selectedHermesSessionIdRef.current = toSessionId;
    setSelectedHermesSessionId(toSessionId);
  }

  function removeOptimisticHermesSession(optimisticSessionId: string, realSessionId?: string) {
    const ids = new Set(
      [optimisticSessionId, realSessionId].filter((sessionId): sessionId is string =>
        Boolean(sessionId),
      ),
    );
    for (const id of ids) {
      moveComposerDraft(sessionComposerDraftKey(id), NEW_SESSION_DRAFT_KEY);
    }
    composerDraftKeyRef.current = NEW_SESSION_DRAFT_KEY;
    setHermesSessionItems((current) => current.filter((session) => !ids.has(session.id)));
    setHermesSessionMessages((current) => {
      let next = current;
      for (const id of ids) next = omitRecordKey(next, id);
      hermesSessionMessagesRef.current = next;
      return next;
    });
    setPendingHermesMessages((current) => {
      let next = current;
      for (const id of ids) next = omitRecordKey(next, id);
      pendingHermesMessagesRef.current = next;
      return next;
    });
    let nextLiveEvents = liveEventsRef.current;
    for (const id of ids) nextLiveEvents = omitRecordKey(nextLiveEvents, id);
    liveEventsRef.current = nextLiveEvents;
    setLiveEvents(nextLiveEvents);
    for (const id of ids) hermesActivityStore.clearSession(id);
    const retrySelection = [...ids]
      .map((id) => sessionModelSelectionsRef.current[id]?.selection)
      .find((selection): selection is SessionModelSelection => Boolean(selection));
    if (retrySelection) {
      // A picker change after Send was staged against the provisional session.
      // If creation rolls back, carry that intent into the restored new-session
      // composer instead of reverting to the model the failed run captured.
      const intentRevision = ++generationSelectionIntentRevisionRef.current;
      defaultGenerationModelIdRef.current = retrySelection.modelId;
      setDefaultGenerationModelId(retrySelection.modelId);
      if (retrySelection.modelId === AUTO_MODEL_ID) {
        generationCostQualityRef.current = retrySelection.costQuality;
        setGenerationCostQuality(retrySelection.costQuality);
      }
      // The provisional selection was session-local while creation was alive.
      // Rollback turns it into the next new-session default, so persist the same
      // transition instead of leaving the pill and Rust provider settings split.
      void saveGenerationSelection(async () => {
        if (retrySelection.modelId.startsWith(LOCAL_GENERATION_OPTION_ID_PREFIX)) {
          await setLocalGenerationEnabled(true);
        } else {
          if (
            retrySelection.modelId === AUTO_MODEL_ID &&
            retrySelection.costQuality !== undefined
          ) {
            await setCostQuality(retrySelection.costQuality);
          }
          await setVeniceModel("generation", retrySelection.modelId);
        }
      })
        .then(() => {
          if (generationSelectionIntentRevisionRef.current === intentRevision) {
            dispatchProviderModelSettingsChanged({
              mode: "generation",
              modelId: retrySelection.modelId,
            });
          }
        })
        .catch(() => undefined);
    }
    let nextSessionModelSelections = sessionModelSelectionsRef.current;
    for (const id of ids) {
      nextSessionModelSelections = forgetSessionModelSelection(id);
    }
    commitSessionModelSelections(nextSessionModelSelections);
    const selectedSessionId = selectedHermesSessionIdRef.current;
    if (selectedSessionId && ids.has(selectedSessionId)) {
      selectedHermesSessionIdRef.current = undefined;
      setSelectedHermesSessionId(undefined);
      newSessionModeRef.current = true;
      setNewSessionMode(true);
    }
  }

  function rememberComputerUseRun(sessionId: string, runLeaseId: string) {
    const leases = computerUseRunLeasesRef.current.get(sessionId) ?? new Set<string>();
    leases.add(runLeaseId);
    computerUseRunLeasesRef.current.set(sessionId, leases);
  }

  async function releaseComputerUseRun(sessionId: string, runLeaseId: string) {
    const leases = computerUseRunLeasesRef.current.get(sessionId);
    leases?.delete(runLeaseId);
    if (leases?.size === 0) computerUseRunLeasesRef.current.delete(sessionId);
    await computerUseEndRun(runLeaseId).catch(() => undefined);
  }

  async function releaseAllComputerUseRuns(sessionId: string) {
    const leases = [...(computerUseRunLeasesRef.current.get(sessionId) ?? [])];
    computerUseRunLeasesRef.current.delete(sessionId);
    await Promise.all(leases.map((lease) => computerUseEndRun(lease).catch(() => undefined)));
  }

  return {
    startOptimisticHermesSession,
    migrateOptimisticHermesSession,
    removeOptimisticHermesSession,
    rememberComputerUseRun,
    releaseComputerUseRun,
    releaseAllComputerUseRuns,
  };
}
