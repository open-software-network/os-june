import {
  reserveHermesSessionDispatch,
  type HermesSessionDispatchReservation,
} from "../../lib/hermes-session-dispatch-mutex";
import { type PendingAttachmentPreparation } from "./composer/follow-up-queue";
import type { createComposerDispatchActionsDependencies } from "./composer-dispatch-actions-types";

export function createComposerDispatchActions(
  dependencies: createComposerDispatchActionsDependencies,
) {
  const {
    activeComposerDispatchReservationsRef,
    completedAgentRunAwaitingAttachmentPreparationRef,
    continueAfterCompletedAgentRun,
    imageSafeModeConsentRequestRef,
    invalidatedComposerDispatchReservationsRef,
    pendingAttachmentPreparationsRef,
    resolveImageSafeModeConsent,
  } = dependencies;

  function reserveComposerDispatch(storedSessionId: string) {
    const reservation = reserveHermesSessionDispatch(storedSessionId);
    activeComposerDispatchReservationsRef.current.set(reservation, storedSessionId);
    return reservation;
  }

  function forgetComposerDispatch(reservation: HermesSessionDispatchReservation | undefined) {
    if (reservation) activeComposerDispatchReservationsRef.current.delete(reservation);
  }

  function cancelComposerDispatch(reservation: HermesSessionDispatchReservation | undefined) {
    reservation?.cancel();
    forgetComposerDispatch(reservation);
  }

  function composerDispatchWasInvalidated(
    reservation: HermesSessionDispatchReservation | undefined,
  ) {
    return Boolean(
      reservation && invalidatedComposerDispatchReservationsRef.current.has(reservation),
    );
  }

  function invalidateSessionComposerDispatches(storedSessionId: string) {
    for (const [
      reservation,
      ownerStoredSessionId,
    ] of activeComposerDispatchReservationsRef.current) {
      if (ownerStoredSessionId !== storedSessionId) continue;
      invalidatedComposerDispatchReservationsRef.current.add(reservation);
      reservation.cancel();
      activeComposerDispatchReservationsRef.current.delete(reservation);
      const consentRequest = imageSafeModeConsentRequestRef.current;
      if (consentRequest?.ownerDispatchReservation === reservation) {
        resolveImageSafeModeConsent({ action: "dismiss" });
      }
    }
  }

  function beginAttachmentPreparation(
    storedSessionId: string,
    dispatchOrder: number,
    dispatchReservation?: HermesSessionDispatchReservation,
  ) {
    const preparation: PendingAttachmentPreparation = {
      dispatchOrder,
      dispatchReservation,
      cancelled: false,
    };
    const pendingPreparations =
      pendingAttachmentPreparationsRef.current[storedSessionId] ??
      new Map<number, PendingAttachmentPreparation>();
    pendingPreparations.set(dispatchOrder, preparation);
    pendingAttachmentPreparationsRef.current[storedSessionId] = pendingPreparations;
    return preparation;
  }

  function finishAttachmentPreparation(
    storedSessionId: string,
    preparation: PendingAttachmentPreparation,
  ) {
    const pendingPreparations = pendingAttachmentPreparationsRef.current[storedSessionId];
    if (pendingPreparations?.get(preparation.dispatchOrder) === preparation) {
      pendingPreparations.delete(preparation.dispatchOrder);
    }
    if (pendingPreparations?.size === 0) {
      delete pendingAttachmentPreparationsRef.current[storedSessionId];
    }
    if (preparation.cancelled) return;
    if (completedAgentRunAwaitingAttachmentPreparationRef.current.delete(storedSessionId)) {
      continueAfterCompletedAgentRun(storedSessionId, Symbol("prepared follow-up"));
    }
  }

  return {
    reserveComposerDispatch,
    forgetComposerDispatch,
    cancelComposerDispatch,
    composerDispatchWasInvalidated,
    invalidateSessionComposerDispatches,
    beginAttachmentPreparation,
    finishAttachmentPreparation,
  };
}
